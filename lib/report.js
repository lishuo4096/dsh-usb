/**
 * UsbTreeView `/R:` 报告解析。
 *
 * ## 报告长什么样
 *
 * 一份 16000 行的纯文本，`====` 划出章节，`----`/`++++` 划出章节内的子块：
 *
 * ```
 *     ========================== My Computer ==========================
 *     ===================== USB Host Controller =======================
 *         +++++++++++++++++ Device Information ++++++++++++++++++
 *         --------------- USB Hostcontroller Info0 --------------
 *     ========================= USB Root Hub =========================
 *     =========================== USB Port1 ===========================
 *           ========================== Summary =========================
 *           ======================== USB Device ========================
 *               ---------------------- Device Descriptor ----------------------
 * ```
 *
 * ## 两个必须靠「Port Chain」而不是行号/缩进判断的点
 *
 * 1. **缩进不可信**：所有章节头都是 4 空格缩进（Summary/Device 是 6），不反映层级。
 * 2. **文件顺序是深度优先的**：一个嵌套 hub 的端口列完之后，文件会**跳回父 hub 剩下的端口**。
 *    实测序列 `Port Chain 3-1-1-4-1..4` 之后紧跟 `3-1-2`，即先钻到最深再回溯。
 *
 * 所以父子关系一律用 `Port Chain` 的**段前缀**判定：
 * 端口 `3-1-1-4-4` 的父 hub 的 chain 就是 `3-1-1-4`。
 *
 * @module lib/report
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, decodeOutput, ensureRunDir, run } from './exec.js';
import { BUS_SPEED, inferKindFromDescriptors, inferKindFromWindows, parseHexMaybe } from './usbcodes.js';

/* ------------------------------------------------------------------ *
 * 底层：章节 / 子块 / 键值行
 * ------------------------------------------------------------------ */

const SECTION_RE = /^\s*={3,}\s*(.+?)\s*={3,}\s*$/;
const BLOCK_RE = /^\s*[-+]{3,}\s*(.+?)\s*[-+]{3,}\s*$/;
// 键名里可以出现空格、括号、`#`、`/`、`-`；行首允许 `-> ` 前缀（`-> CompanionPortChain : 1-4`）。
const KV_RE = /^\s*(?:->\s*)?([A-Za-z][A-Za-z0-9 ()[\]/<>#*_,.\-]{0,45}?)\s*:\s?(.*)$/;

/**
 * 把一个章节标题归一成类型。
 * @param {string} title
 */
function classifySection(title) {
  const t = title.trim();
  if (/^My Computer$/i.test(t)) return { kind: 'computer', title: t };
  if (/^USB Host Controller$/i.test(t)) return { kind: 'controller', title: t };
  if (/^USB Root Hub$/i.test(t)) return { kind: 'roothub', title: t };
  if (/^USB Hub$/i.test(t)) return { kind: 'hub', title: t };
  if (/^USB Device$/i.test(t)) return { kind: 'device', title: t };
  if (/^USB Port\s*(\d+)$/i.test(t)) {
    return { kind: 'port', title: t, portNumber: Number(/^USB Port\s*(\d+)$/i.exec(t)[1]) };
  }
  if (/^Summary$/i.test(t)) return { kind: 'summary', title: t };
  return { kind: 'other', title: t };
}

/**
 * 拆章节。
 * @param {string} text
 */
export function splitSections(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = SECTION_RE.exec(lines[i]);
    if (m) {
      if (current) current.end = i;
      current = { ...classifySection(m[1]), start: i, end: lines.length, lineNo: i + 1 };
      sections.push(current);
    }
  }
  for (const s of sections) s.lines = lines.slice(s.start + 1, s.end);
  return sections;
}

/**
 * 解析一个「键: 值」行。值里可能带括注，例如 `0x03 (HID - Human Interface Device)`。
 * @param {string} line
 */
function parseKvLine(line) {
  const m = KV_RE.exec(line);
  if (!m) return null;
  const key = m[1].trim();
  const value = m[2].trim();
  const out = { key, raw: value };
  const hex = /^(0x[0-9A-Fa-f]+)\s*(?:\((.*)\))?\s*$/.exec(value);
  if (hex) {
    out.hex = parseInt(hex[1], 16);
    if (hex[2] !== undefined) out.note = hex[2].trim();
  } else {
    const par = /^(.+?)\s*\(([^()]*)\)\s*$/.exec(value);
    if (par) {
      out.text = par[1].trim();
      out.note = par[2].trim();
    } else if (value && !/^-+$/.test(value)) {
      out.text = value;
    }
  }
  return out;
}

/**
 * 把一个章节切成若干子块。
 *
 * @param {string[]} lines
 * @returns {{name: string, lineNo: number, entries: Array<{key:string, raw:string, hex?:number,
 *   note?:string, text?:string}>, raw: string[]}[]}
 */
function splitBlocks(lines) {
  const blocks = [];
  let current = { name: '(preamble)', lineNo: 0, entries: [], raw: [] };
  const flush = () => {
    if (current.entries.length || current.raw.length || current.name !== '(preamble)') blocks.push(current);
    current = { name: '(preamble)', lineNo: 0, entries: [], raw: [] };
  };
  for (const line of lines) {
    const bm = BLOCK_RE.exec(line);
    if (bm) {
      flush();
      current.name = bm[1].trim();
      continue;
    }
    if (!line.trim()) continue;
    const kv = parseKvLine(line);
    if (kv) current.entries.push(kv);
    else current.raw.push(line.trim());
  }
  flush();
  // 注意：**保留** `(preamble)` 块。端口章节的 `Connection Status`/`Port Chain`、
  // `My Computer` 的全部内容、hub 的 `Sum of ...` 都在第一个 `----` 子块**之前**。
  return blocks;
}

/** 从条目数组里取第一个匹配键的值（不区分大小写，支持多个别名）。 */
function pick(entries, ...names) {
  for (const name of names) {
    const lower = name.toLowerCase();
    const hit = entries.find((e) => e.key.toLowerCase() === lower);
    if (hit) return hit;
  }
  return undefined;
}

const rawOf = (entries, ...names) => pick(entries, ...names)?.raw;
const textOf = (entries, ...names) => {
  const e = pick(entries, ...names);
  if (!e) return undefined;
  return e.text ?? e.note ?? e.raw;
};
const hexOf = (entries, ...names) => pick(entries, ...names)?.hex;

/** 取某个键**后面紧跟的**那一行的值（用于 `iProduct` 之后的 `Language 0x0409` 字符串）。 */
function valueAfter(entries, keyName) {
  const idx = entries.findIndex((e) => e.key.toLowerCase() === keyName.toLowerCase());
  if (idx < 0) return undefined;
  for (let i = idx + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (/^Language\s+0x/i.test(e.key)) {
      const m = /^"(.*)"\s*(?:\*!\*.*)?$/.exec(e.raw);
      return m ? m[1] : e.raw;
    }
    if (/^[a-zA-Z]/.test(e.key) && !/^Language/i.test(e.key)) break;
  }
  return undefined;
}

/** 从 `USB\VID_24AE&PID_4077\...` 里抠 VID/PID。 */
function vidPidFromInstance(instanceId) {
  const m = /VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})/i.exec(String(instanceId ?? ''));
  if (!m) return {};
  return { vid: parseInt(m[1], 16), pid: parseInt(m[2], 16) };
}

/**
 * 解析一段 `Device Information` 块（控制器 / hub / 设备 / 复合子设备都用它）。
 * @param {Array} entries
 */
function parseDeviceInfo(entries) {
  const instanceId = rawOf(entries, 'Device ID');
  return {
    description: rawOf(entries, 'Device Description'),
    friendlyName: rawOf(entries, 'Friendly Name'),
    busReportedDesc: rawOf(entries, 'BusReported Device Desc'),
    instanceId,
    hardwareIds: rawOf(entries, 'Hardware IDs'),
    driver: rawOf(entries, 'Driver'),
    driverInf: rawOf(entries, 'Driver Inf'),
    service: rawOf(entries, 'Service'),
    className: rawOf(entries, 'Class'),
    classGuid: rawOf(entries, 'Class GUID'),
    enumerator: rawOf(entries, 'Enumerator'),
    locationInfo: rawOf(entries, 'Location Info'),
    locationIds: rawOf(entries, 'Location IDs'),
    containerId: rawOf(entries, 'Container ID'),
    address: hexOf(entries, 'Address') ?? parseHexMaybe(rawOf(entries, 'Address')),
    capabilities: rawOf(entries, 'Capabilities'),
    status: rawOf(entries, 'Status'),
    powerState: rawOf(entries, 'Power State'),
    vendor: rawOf(entries, 'Vendor'),
    manufacturerInfo: rawOf(entries, 'Manufacturer Info'),
    parentHierarchy: rawOf(entries, 'Parent Device Hierarchy'),
    ...vidPidFromInstance(instanceId),
  };
}

/** `Device Descriptor` 块。 */
function parseDeviceDescriptor(entries) {
  if (!entries.length) return undefined;
  return {
    bLength: hexOf(entries, 'bLength'),
    bcdUSB: hexOf(entries, 'bcdUSB'),
    bcdUSBText: pick(entries, 'bcdUSB')?.note,
    bDeviceClass: hexOf(entries, 'bDeviceClass'),
    bDeviceClassNote: pick(entries, 'bDeviceClass')?.note,
    bDeviceSubClass: hexOf(entries, 'bDeviceSubClass'),
    bDeviceProtocol: hexOf(entries, 'bDeviceProtocol'),
    bMaxPacketSize0: hexOf(entries, 'bMaxPacketSize0'),
    idVendor: hexOf(entries, 'idVendor'),
    idVendorName: pick(entries, 'idVendor')?.note,
    idProduct: hexOf(entries, 'idProduct'),
    bcdDevice: hexOf(entries, 'bcdDevice'),
    iManufacturer: hexOf(entries, 'iManufacturer'),
    manufacturerString: valueAfter(entries, 'iManufacturer'),
    iProduct: hexOf(entries, 'iProduct'),
    productString: valueAfter(entries, 'iProduct'),
    iSerialNumber: hexOf(entries, 'iSerialNumber'),
    serialString: valueAfter(entries, 'iSerialNumber'),
    bNumConfigurations: hexOf(entries, 'bNumConfigurations'),
  };
}

/** `Configuration Descriptor` 块。 */
function parseConfigDescriptor(entries) {
  if (!entries.length) return undefined;
  // bmAttributes 才是权威：bit7 恒为 1（保留位），bit6 = 自供电，bit5 = 远程唤醒。
  // 报告里的 `D6: Self Powered : 0x00 (no)` 是**子行**，键会被首冒号切成 `D6`，
  // 直接把 note 当 "selfPowered" 用读不到 —— 早前就是这么错的。
  const bm = hexOf(entries, 'bmAttributes');
  const bmNote = pick(entries, 'bmAttributes')?.note;
  const maxPowerEntry = pick(entries, 'MaxPower');
  return {
    wTotalLength: hexOf(entries, 'wTotalLength'),
    bNumInterfaces: hexOf(entries, 'bNumInterfaces'),
    bConfigurationValue: hexOf(entries, 'bConfigurationValue'),
    bmAttributes: bm,
    bmAttributesNote: bmNote,
    selfPowered: typeof bm === 'number' ? (bm & 0x40) !== 0 : undefined,
    remoteWakeup: typeof bm === 'number' ? (bm & 0x20) !== 0 : undefined,
    maxPowerMa: maxPowerEntry?.note ? Number(/(\d+)\s*mA/.exec(maxPowerEntry.note)?.[1]) : undefined,
    maxPowerRaw: maxPowerEntry?.hex,
  };
}

/** `Interface Descriptor` 块。 */
function parseInterfaceDescriptor(entries) {
  return {
    bInterfaceNumber: hexOf(entries, 'bInterfaceNumber'),
    bAlternateSetting: hexOf(entries, 'bAlternateSetting'),
    bNumEndpoints: hexOf(entries, 'bNumEndpoints'),
    class: hexOf(entries, 'bInterfaceClass'),
    classNote: pick(entries, 'bInterfaceClass')?.note,
    subClass: hexOf(entries, 'bInterfaceSubClass'),
    subClassNote: pick(entries, 'bInterfaceSubClass')?.note,
    protocol: hexOf(entries, 'bInterfaceProtocol'),
    protocolNote: pick(entries, 'bInterfaceProtocol')?.note,
    iInterface: hexOf(entries, 'iInterface'),
    endpoints: [],
    hid: undefined,
  };
}

/** `Endpoint Descriptor` 块。 */
function parseEndpointDescriptor(entries) {
  return {
    address: hexOf(entries, 'bEndpointAddress'),
    addressNote: pick(entries, 'bEndpointAddress')?.note,
    attributes: hexOf(entries, 'bmAttributes'),
    transferTypeNote: pick(entries, 'bmAttributes')?.note,
    wMaxPacketSize: hexOf(entries, 'wMaxPacketSize'),
    bInterval: hexOf(entries, 'bInterval'),
    bIntervalNote: pick(entries, 'bInterval')?.note,
  };
}

/** `Connection Information` 块。 */
function parseConnectionInfo(entries) {
  if (!entries.length) return undefined;
  const pipes = entries
    .filter((e) => /^Pipe\[\d+\]$/i.test(e.key))
    .map((e) => e.raw);
  const statusEntry = pick(entries, 'Connection Status');
  return {
    connectionIndex: hexOf(entries, 'Connection Index'),
    connectionIndexNote: pick(entries, 'Connection Index')?.note,
    status: statusEntry?.hex,
    statusNote: statusEntry?.note,
    currentConfig: hexOf(entries, 'Current Config Value'),
    deviceAddress: hexOf(entries, 'Device Address'),
    isHub: pick(entries, 'Is Hub')?.note ?? (hexOf(entries, 'Is Hub') === 1 ? 'yes' : 'no'),
    busSpeed: hexOf(entries, 'Device Bus Speed'),
    busSpeedText: pick(entries, 'Device Bus Speed')?.note ?? BUS_SPEED[hexOf(entries, 'Device Bus Speed')],
    openPipes: hexOf(entries, 'Number of open Pipes'),
    pipes,
  };
}

/** `Summary` 章节（挂在某个 Port 下）。 */
function parseSummary(section) {
  const blocks = splitBlocks(section.lines);
  const entries = blocks.flatMap((b) => b.entries);
  if (!entries.length) return undefined;
  const vidEntry = pick(entries, 'Vendor ID');
  const pidEntry = pick(entries, 'Product ID');
  return {
    vid: vidEntry?.hex,
    vidName: vidEntry?.note,
    pid: pidEntry?.hex,
    manufacturerString: pick(entries, 'Manufacturer String')?.raw,
    productString: pick(entries, 'Product String')?.raw,
    serial: pick(entries, 'Serial')?.raw,
    usbVersion: pick(entries, 'USB Version')?.text ?? pick(entries, 'USB Version')?.raw,
    portMaxSpeed: pick(entries, 'Port maximum Speed')?.raw,
    deviceMaxSpeed: pick(entries, 'Device maximum Speed')?.raw,
    connectionSpeed: pick(entries, 'Device Connection Speed')?.raw,
    selfPowered: pick(entries, 'Self powered')?.raw,
    demandedCurrent: pick(entries, 'Demanded Current')?.raw,
    usedEndpoints: parseHexMaybe(pick(entries, 'Used Endpoints')?.raw),
  };
}

/** `USB Port` 章节头部（连接状态、端口链、伴侣端口）。 */
function parsePort(section) {
  const entries = splitBlocks(section.lines).flatMap((b) => b.entries);
  const statusEntry = pick(entries, 'Connection Status');
  const chainRaw = rawOf(entries, 'Port Chain');
  const companionChain = rawOf(entries, '-> CompanionPortChain', 'CompanionPortChain');
  const companionPort = pick(entries, 'CompanionPortNumber')?.hex;
  return {
    portNumber: section.portNumber,
    chain: chainRaw ? chainRaw.trim() : undefined,
    connected: statusEntry?.hex === undefined ? undefined : statusEntry.hex !== 0,
    connectionStatus: statusEntry?.hex,
    connectionStatusNote: statusEntry?.note,
    properties: rawOf(entries, 'Properties'),
    userConnectable: pick(entries, 'IsUserConnectable')?.raw ?? pick(entries, 'Properties')?.note,
    typeC: pick(entries, 'PortConnectorIsTypeC')?.raw,
    debugCapable: pick(entries, 'PortIsDebugCapable')?.raw,
    connectionIndex: hexOf(entries, 'ConnectionIndex') ?? hexOf(entries, 'Connection Index'),
    companionPort,
    companionChain: companionChain ? companionChain.trim() : undefined,
    summary: undefined,
    device: undefined,
  };
}

/**
 * 解析一个 `USB Device` / `USB Hub` 章节。
 *
 * 章节里的子块按出现顺序排队，接口描述符之间会夹杂 HID / Endpoint / 类特定描述符，
 * 所以按「看到 Interface 就起新接口，其余描述符归到当前接口」的规则归位。
 *
 * @param {ReturnType<typeof splitSections>[number]} section
 * @param {'device'|'hub'} kind
 */
function parseDeviceSection(section, kind) {
  const blocks = splitBlocks(section.lines);
  const node = {
    kind,
    sectionLine: section.lineNo,
    info: undefined,
    connection: undefined,
    descriptor: undefined,
    config: undefined,
    interfaces: [],
    stringDescriptors: [],
    children: [],
    hubDescriptor: undefined,
    hubCapabilities: undefined,
    hubCapabilitiesEx: undefined,
    extraBlocks: [],
    sumHubsAndDevices: undefined,
    sumEndpoints: undefined,
  };

  const infoBlocks = blocks.filter((b) => /^Device Information$/i.test(b.name));
  const stringBlocks = blocks.filter((b) => /^String Descriptor \d+$/i.test(b.name));

  if (infoBlocks[0]) node.info = parseDeviceInfo(infoBlocks[0].entries);
  // 复合设备：主体之后还有若干 `Device Information` 块，它们是子设备（每个接口一个 PDO）
  for (let i = 1; i < infoBlocks.length; i += 1) {
    node.children.push(parseDeviceInfo(infoBlocks[i].entries));
  }

  let currentInterface = null;
  for (const block of blocks) {
    const name = block.name;
    if (name === '(preamble)') continue;
    if (/^Device Information$/i.test(name)) continue;
    if (/^String Descriptor \d+$/i.test(name)) {
      const idx = Number(/^String Descriptor (\d+)$/i.exec(name)[1]);
      // 0 号描述符是语言表，键名是 `Language ID[0]`（不是 `Language 0x0409`）；
      // 其余描述符是 `Language 0x0409 : "文案"`。早前只认后者，0 号的语言就丢了。
      const langEntry = block.entries.find(
        (e) => /^Language\s+0x/i.test(e.key) || /^Language ID\[/i.test(e.key),
      );
      const textEntry = block.entries.find((e) => /^Language\s+0x/i.test(e.key));
      const m = textEntry ? /^"(.*)"\s*(?:\*!\*.*)?$/.exec(textEntry.raw) : null;
      const langHex =
        /0x([0-9A-Fa-f]+)/.exec(langEntry?.key ?? '')?.[1] ?? /0x([0-9A-Fa-f]+)/.exec(langEntry?.raw ?? '')?.[1];
      node.stringDescriptors.push({
        index: idx,
        length: hexOf(block.entries, 'bLength'),
        languageId: langHex ? parseInt(langHex, 16) : undefined,
        languageHex: langHex ? `0x${langHex.toUpperCase().padStart(4, '0')}` : undefined,
        // 0 号没有正文（只有语言 ID），这里给空串而不是把 raw 塞进去。
        text: m ? m[1] : textEntry?.raw ?? (idx === 0 ? '' : undefined),
      });
      continue;
    }
    if (/^Registry USB Flags$/i.test(name)) {
      node.registryFlags = block.raw;
      continue;
    }
    switch (true) {
      case /^Connection Information$/i.test(name):
        node.connection = parseConnectionInfo(block.entries);
        break;
      case /^Connection Information V2$/i.test(name):
        node.connectionV2 = Object.fromEntries(block.entries.map((e) => [e.key, e.raw]));
        break;
      case /^Device Descriptor$/i.test(name):
        node.descriptor = parseDeviceDescriptor(block.entries);
        break;
      case /^Device Qualifier Descriptor/i.test(name):
        node.deviceQualifier = Object.fromEntries(block.entries.map((e) => [e.key, e.raw]));
        break;
      case /^Configuration Descriptor$/i.test(name):
        node.config = parseConfigDescriptor(block.entries);
        break;
      case /^Interface Descriptor$/i.test(name):
        currentInterface = parseInterfaceDescriptor(block.entries);
        node.interfaces.push(currentInterface);
        break;
      case /^Endpoint Descriptor$/i.test(name):
        if (currentInterface) currentInterface.endpoints.push(parseEndpointDescriptor(block.entries));
        break;
      case /^HID Descriptor$/i.test(name):
        if (currentInterface) {
          currentInterface.hid = {
            bcdHID: hexOf(block.entries, 'bcdHID'),
            countryCode: hexOf(block.entries, 'bCountryCode'),
            numDescriptors: hexOf(block.entries, 'bNumDescriptors'),
            reportDescriptorLength: hexOf(block.entries, 'wDescriptorLength'),
          };
        }
        break;
      case /^USB Hub Descriptor$/i.test(name):
        node.hubDescriptor = {
          length: hexOf(block.entries, 'bDescriptorLength'),
          ports: hexOf(block.entries, 'bNumberOfPorts'),
          characteristics: hexOf(block.entries, 'wHubCharacteristics'),
          powerOnToPowerGood: hexOf(block.entries, 'bPowerOnToPowerGood'),
          hubControlCurrent: hexOf(block.entries, 'bHubControlCurrent'),
          deviceRemovable: hexOf(block.entries, 'DeviceRemovable'),
          selfPowered: /self powered/i.test(pick(block.entries, 'HubIsBusPowered')?.note ?? ''),
        };
        break;
      case /^USB Hub Capabilities$/i.test(name):
        node.hubCapabilities = Object.fromEntries(block.entries.map((e) => [e.key, e.raw]));
        break;
      case /^USB Hub Capabilities Ex$/i.test(name):
        node.hubCapabilitiesEx = Object.fromEntries(block.entries.map((e) => [e.key, e.raw]));
        break;
      case /^Sum of/i.test(block.raw.join(' ')):
        break;
      default: {
        // 类特定描述符（音频/视频/HID 报表）与系统信息块：保留但不在主视图里展开
        node.extraBlocks.push({
          name,
          entries: block.entries.map((e) => ({ key: e.key, value: e.raw })),
        });
      }
    }
  }

  // `Sum of Hubs and Devices` 这类统计行在 preamble 里，被 splitBlocks 丢掉了，
  // 所以回到原始行再找一次。
  for (const line of section.lines) {
    const a = /^Sum of Hubs and Devices\s*:\s*(\d+)/i.exec(line);
    if (a) node.sumHubsAndDevices = Number(a[1]);
    const b = /^Sum of Endpoints\s*:\s*(\d+)/i.exec(line);
    if (b) node.sumEndpoints = Number(b[1]);
  }

  return node;
}

/** `USB Host Controller` 章节：控制器信息 + 支持的端口数。 */
function parseControllerSection(section) {
  const blocks = splitBlocks(section.lines);
  const infoBlock = blocks.find((b) => /^Device Information$/i.test(b.name));
  const info = infoBlock ? parseDeviceInfo(infoBlock.entries) : {};
  const hcInfoBlock = blocks.find((b) => /^USB Hostcontroller Info0$/i.test(b.name));
  const busStatBlock = blocks.find((b) => /^USB Hostcontroller BusStatistics$/i.test(b.name));
  return {
    name: info.friendlyName ?? info.description ?? `USB Host Controller #${section.lineNo}`,
    info,
    pciVendorId: hcInfoBlock ? hexOf(hcInfoBlock.entries, 'PciVendorId') : undefined,
    pciDeviceId: hcInfoBlock ? hexOf(hcInfoBlock.entries, 'PciDeviceId') : undefined,
    rootPorts: hcInfoBlock ? hexOf(hcInfoBlock.entries, 'NumberOfRootPorts') : undefined,
    busDeviceCount: busStatBlock ? hexOf(busStatBlock.entries, 'DeviceCount') : undefined,
    rootHubSymbolicLink: rawOf(blocks.flatMap((b) => b.entries), 'Roothub Symbolic Link'),
    rootHub: undefined,
  };
}

/** `My Computer` 章节。 */
function parseComputerSection(section) {
  const entries = splitBlocks(section.lines).flatMap((b) => b.entries);
  const num = (k) => {
    const v = rawOf(entries, k);
    return v === undefined ? undefined : Number.parseInt(v, 10);
  };
  return {
    manufacturer: rawOf(entries, 'Manufacturer'),
    product: rawOf(entries, 'Product'),
    os: rawOf(entries, 'Operating System'),
    upTime: rawOf(entries, 'Up Time'),
    computerName: rawOf(entries, 'Computer Name'),
    userName: rawOf(entries, 'User Name'),
    adminPrivileges: rawOf(entries, 'Admin Privileges'),
    uac: rawOf(entries, 'User Account Control'),
    treeViewVersion: rawOf(entries, 'UsbTreeView Version'),
    settings: rawOf(entries, 'Settings'),
    counts: {
      hostControllers: num('USB Host Controllers'),
      rootHubs: num('USB Root Hubs'),
      standardHubs: num('USB Standard Hubs'),
      peripheralDevices: num('USB Peripheral Devices'),
      childDevices: num('USB Child Devices'),
    },
    filterDrivers: entries
      .filter((e) => /^USB (Upper|Lower)$/i.test(e.key))
      .map((e) => ({ stage: e.key, drivers: e.raw })),
  };
}

/* ------------------------------------------------------------------ *
 * 主解析入口
 * ------------------------------------------------------------------ */

/** `Port Chain` 的父链：`3-1-1-4-4` → `3-1-1-4`。 */
function parentChain(chain) {
  if (!chain) return undefined;
  const idx = chain.lastIndexOf('-');
  return idx < 0 ? undefined : chain.slice(0, idx);
}

/**
 * 解析整份报告。
 *
 * @param {string} text
 * @returns {{meta: object, controllers: object[], devices: object[], ports: object[], hubs: object[]}}
 */
export function parseReport(text) {
  const sections = splitSections(text);
  const meta = {};
  const controllers = [];
  /** @type {Map<string, any>} chain → hub 节点 */
  const hubsByChain = new Map();
  const allDevices = [];
  const allPorts = [];

  let currentController = null;
  let currentHub = null;
  let lastHub = null;
  let pendingPort = null;

  for (const section of sections) {
    switch (section.kind) {
      case 'computer':
        Object.assign(meta, parseComputerSection(section));
        break;

      case 'controller': {
        currentController = parseControllerSection(section);
        currentController.index = controllers.length + 1;
        currentController.chain = String(currentController.index);
        controllers.push(currentController);
        currentHub = null;
        lastHub = null;
        pendingPort = null;
        break;
      }

      case 'roothub': {
        const node = parseDeviceSection(section, 'hub');
        node.chain = currentController?.chain ?? `H${hubsByChain.size}`;
        node.isRootHub = true;
        node.ports = [];
        if (currentController) currentController.rootHub = node;
        hubsByChain.set(node.chain, node);
        currentHub = node;
        lastHub = node;
        pendingPort = null;
        break;
      }

      case 'port': {
        const port = parsePort(section);
        if (!port.chain) {
          // 没有 Port Chain 时按文件顺序退化：挂到最近一个 hub 上
          port.chain = `${lastHub?.chain ?? '?'}-${port.portNumber}`;
          port.chainInferred = true;
        }
        const chainKey = parentChain(port.chain);
        const parent = (chainKey && hubsByChain.get(chainKey)) ?? lastHub ?? currentHub;
        port.parentChain = chainKey;
        if (parent) {
          parent.ports ??= [];
          parent.ports.push(port);
          port.parentHubInstanceId = parent.info?.instanceId;
          port.parentHubChain = parent.chain;
        }
        allPorts.push(port);
        pendingPort = port;
        break;
      }

      case 'summary':
        if (pendingPort) pendingPort.summary = parseSummary(section);
        break;

      case 'hub':
      case 'device': {
        const node = parseDeviceSection(section, section.kind);
        node.chain = pendingPort?.chain;
        node.ports = [];
        if (pendingPort) {
          pendingPort.device = node;
          node.portNumber = pendingPort.portNumber;
          node.portChain = pendingPort.chain;
        }
        // 复合子设备也是「设备」，一起进扁平表（带父设备引用）
        node.childCount = node.children.length;
        allDevices.push(node);
        for (const child of node.children) {
          child.parentDeviceInstanceId = node.info?.instanceId;
          child.portChain = node.portChain;
          child.isChild = true;
          allDevices.push(child);
        }
        if (section.kind === 'hub') {
          hubsByChain.set(node.chain ?? `H${hubsByChain.size}`, node);
          currentHub = node;
          lastHub = node;
        }
        pendingPort = null;
        break;
      }

      default:
        break;
    }
  }

  // 补全派生字段：VID/PID 回退、速度、类型判定、端口链
  const tidy = (v) => (typeof v === 'string' ? v.replace(/\s+$/, '').trim() : v);
  // bcdDevice 是 BCD 码：高字节主版本、低字节次版本（0x0111 → 1.11）
  const fmtBcd = (v) =>
    typeof v === 'number' ? `${(v >> 8) & 0xff}.${String(v & 0xff).padStart(2, '0')}` : undefined;
  for (const dev of allDevices) {
    const info = dev.info ?? {};
    dev.instanceId = info.instanceId;
    dev.vid = dev.descriptor?.idVendor ?? info.vid;
    dev.pid = dev.descriptor?.idProduct ?? info.pid;
    dev.vendorName = dev.descriptor?.idVendorName;
    dev.productName = tidy(
      dev.descriptor?.productString ??
        dev.stringDescriptors?.find((s) => s.index === 2)?.text ??
        info.busReportedDesc ??
        info.description,
    );
    dev.manufacturerName = tidy(
      dev.descriptor?.manufacturerString ?? dev.stringDescriptors?.find((s) => s.index === 1)?.text,
    );
    dev.serialNumber = tidy(
      dev.descriptor?.serialString ?? dev.stringDescriptors?.find((s) => s.index === 3)?.text,
    );
    dev.revision = fmtBcd(dev.descriptor?.bcdDevice);
    dev.revisionRaw = dev.descriptor?.bcdDevice;
    dev.speed = dev.connection?.busSpeedText ?? undefined;
    dev.kindGuess = inferKindFromDescriptors({
      deviceClass: dev.descriptor?.bDeviceClass ?? (dev.kind === 'hub' ? 0x09 : undefined),
      interfaces: dev.interfaces,
    });
    if (dev.isChild) {
      // 复合设备的子设备（同一物理设备的每个接口各一个 PDO）没有自己的描述符，
      // 只能按 Windows 侧的服务名/描述判型。
      dev.kindGuess = inferKindFromWindows({
        description: dev.info?.description,
        className: dev.info?.className,
        service: dev.info?.service,
        instanceId: dev.info?.instanceId,
      });
    }
    if (dev.kind === 'hub' && dev.isRootHub) {
      dev.kindGuess = { kind: 'root-hub', zh: 'USB 根集线器', evidence: '章节类型 USB Root Hub' };
    }
  }
  for (const port of allPorts) {
    if (port.summary && port.device) {
      port.device.summaryVidName = port.summary.vidName;
    }
  }

  return { meta, controllers, devices: allDevices, ports: allPorts, hubs: allDevices.filter((d) => d.kind === 'hub') };
}

/* ------------------------------------------------------------------ *
 * 报告生成 + 缓存
 * ------------------------------------------------------------------ */

const REPORT_DIR = () => ensureRunDir('reports');
const INDEX_PATH = () => join(REPORT_DIR(), 'index.json');

function readIndex() {
  try {
    return JSON.parse(readFileSync(INDEX_PATH(), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeIndex(value) {
  try {
    writeFileSync(INDEX_PATH(), JSON.stringify(value, null, 2), 'utf8');
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

/**
 * 生成（或复用）一份 UsbTreeView 报告。
 *
 * `/R:` 是**静默**的、不开窗，但整份报告要 **~10 秒**、1.7 MB，所以一定要缓存：
 * 同一个 TTL 内多次调用只跑一次。TTL 默认 5 分钟。
 *
 * @param {object} opts
 * @param {string} opts.exePath UsbTreeView.exe 绝对路径
 * @param {number} [opts.maxAgeMs] 缓存有效期，默认 300000；传 0 强制重新生成
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, text?:string, path?:string, generatedAt?:number, cached?:boolean,
 *   durationMs?:number, error?:string, code?:string}>}
 */
export async function generateReport(opts) {
  const { exePath, maxAgeMs = 300_000, timeoutMs = 120_000 } = opts;
  const dir = REPORT_DIR();
  const index = readIndex();

  if (maxAgeMs > 0 && index?.path && existsSync(index.path)) {
    const age = Date.now() - Number(index.generatedAt ?? 0);
    if (age >= 0 && age < maxAgeMs) {
      try {
        const buf = readFileSync(index.path);
        return {
          ok: true,
          text: decodeOutput(buf, 'utf16le'),
          path: index.path,
          generatedAt: index.generatedAt,
          cached: true,
          durationMs: 0,
        };
      } catch {
        /* 缓存读不出来就重新生成 */
      }
    }
  }

  if (!exePath) {
    return { ok: false, code: 'no-usbtreeview', error: '没有可用的 UsbTreeView.exe 路径' };
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outPath = join(dir, `report-${stamp}.txt`);
  mkdirSync(dir, { recursive: true });

  const res = await run(exePath, [`/R:${outPath}`], { timeoutMs });

  if (!existsSync(outPath)) {
    return {
      ok: false,
      code: 'report-not-created',
      error: `${res.error ?? 'UsbTreeView 没有生成报告文件'}（退出码 ${res.code}${
        res.stderr ? `，stderr: ${res.stderr.trim().slice(0, 300)}` : ''
      }）`,
      durationMs: res.durationMs,
    };
  }

  let text;
  try {
    text = decodeOutput(readFileSync(outPath), 'utf16le');
  } catch (error) {
    return { ok: false, code: 'report-unreadable', error: `报告无法读取：${String(error?.message ?? error)}` };
  }

  const generatedAt = Date.now();
  writeIndex({ path: outPath, generatedAt, sizeBytes: statSync(outPath).size });

  // 只留最近 3 份，避免 .run 无限膨胀
  try {
    const files = readdirSync(dir)
      .filter((f) => /^report-\d+\.txt$/.test(f))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(3)) rmSync(join(dir, stale.f), { force: true });
  } catch {
    /* 清理失败无所谓 */
  }

  return { ok: true, text, path: outPath, generatedAt, cached: false, durationMs: res.durationMs, RUN_DIR };
}
