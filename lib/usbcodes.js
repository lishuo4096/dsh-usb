/**
 * USB 代码表与「设备类型」归类。
 *
 * 数据来源：USB-IF 官方 *Defined Class Codes* 与 USB 2.0/3.2 规范第 9 章描述符定义。
 * https://www.usb.org/defined-class-codes
 *
 * ## 为什么要自己归类
 *
 * USB 规范只给 `bDeviceClass` / `bInterfaceClass` 这类**代码**，而「这是什么设备」是
 * 人在问的问题。一个 `0x00` 的设备必须看接口类才知道是键盘还是摄像头；一个 `0x08` 的
 * 存储设备在 Windows 里叫 U 盘还是移动硬盘，又得看它挂的驱动。所以这里做两层：
 *
 * 1. {@link classifyInterface} / {@link classifyDeviceClass} —— 规范层，代码 → 名字
 * 2. {@link inferKindFromWindows} —— 平台层，Windows 描述/服务名 → 人话类型
 *
 * @module lib/usbcodes
 */

/** `bDeviceClass` / `bInterfaceClass` 代码表（USB-IF Defined Class Codes）。 */
export const USB_CLASS = {
  0x00: { name: 'Per-Interface', zh: '由接口定义' },
  0x01: { name: 'Audio', zh: '音频' },
  0x02: { name: 'Communications and CDC Control', zh: '通信 / CDC' },
  0x03: { name: 'Human Interface Device (HID)', zh: '人机接口 (HID)' },
  0x05: { name: 'Physical', zh: '物理设备' },
  0x06: { name: 'Image', zh: '图像（扫描仪/摄像头）' },
  0x07: { name: 'Printer', zh: '打印机' },
  0x08: { name: 'Mass Storage', zh: '大容量存储' },
  0x09: { name: 'Hub', zh: '集线器' },
  0x0a: { name: 'CDC-Data', zh: 'CDC 数据' },
  0x0b: { name: 'Smart Card', zh: '智能卡' },
  0x0d: { name: 'Content Security', zh: '内容安全' },
  0x0e: { name: 'Video', zh: '视频（摄像头）' },
  0x0f: { name: 'Personal Healthcare', zh: '个人医疗' },
  0x10: { name: 'Audio/Video Devices', zh: '音视频设备' },
  0x11: { name: 'Billboard Device', zh: '公告板设备' },
  0x12: { name: 'USB Type-C Bridge', zh: 'USB-C 桥' },
  0x14: { name: 'USB Bulk Display', zh: 'USB 批量显示' },
  0xdc: { name: 'Diagnostic Device', zh: '诊断设备' },
  0xe0: { name: 'Wireless Controller', zh: '无线控制器' },
  0xef: { name: 'Miscellaneous', zh: '杂项' },
  0xfe: { name: 'Application Specific', zh: '应用专用' },
  0xff: { name: 'Vendor Specific', zh: '厂商自定义' },
};

/** HID `bInterfaceSubClass` 里最常被问的几个。 */
export const HID_SUBCLASS = {
  0x00: 'No Subclass',
  0x01: 'Boot Interface Subclass',
};

/** HID `bInterfaceProtocol`（Boot 子类下才有确定语义）。 */
export const HID_PROTOCOL = {
  0x00: 'None',
  0x01: 'Keyboard',
  0x02: 'Mouse',
};

/** CDC `bInterfaceSubClass` 常见值。 */
export const CDC_SUBCLASS = {
  0x00: 'reserved',
  0x01: 'Direct Line Control Model',
  0x02: 'Abstract Control Model (ACM)',
  0x03: 'Telephone Control Model',
  0x04: 'Multi-Channel Control Model',
  0x05: 'CAPI Control Model',
  0x06: 'Ethernet Networking Control Model',
  0x07: 'ATM Networking Control Model',
  0x08: 'Wireless Handset Control Model',
  0x09: 'Device Management',
  0x0a: 'Mobile Direct Line Model',
  0x0b: 'OBEX',
  0x0c: 'Ethernet Emulation Model',
  0x0d: 'Network Control Model (NCM)',
};

/** 大容量存储 `bInterfaceSubClass`。 */
export const MSC_SUBCLASS = {
  0x01: 'RBC',
  0x02: 'MMC-5 (ATAPI)',
  0x03: 'QIC-157',
  0x04: 'UFI',
  0x05: 'SFF-8070i (Floppy)',
  0x06: 'SCSI transparent (UASP / 磁盘)',
  0x07: 'LSD FS',
};

/** 字符串形式的枚举值 → 数值。报告里既有 `0x03` 也有裸十进制。 */
export function parseHexMaybe(text) {
  if (text === undefined || text === null) return undefined;
  const s = String(text).trim();
  if (!s) return undefined;
  let m = /^0x([0-9a-f]+)$/i.exec(s);
  if (m) return parseInt(m[1], 16);
  m = /^(?:0x)?([0-9a-f]+)\s*\(/i.exec(s);
  if (m) return parseInt(m[1], 16);
  if (/^[0-9]+$/.test(s)) {
    // `bInterfaceNumber: 0` 这类裸数字是十进制；但 `bcdUSB: 0x0200` 已在上面的分支处理。
    return Number(s);
  }
  return undefined;
}

/**
 * 把一个 `bInterfaceClass` 代码翻成人话，并尽量细分到「哪个驱动会接管它」。
 *
 * @param {number} cls
 * @param {number} [subClass]
 * @param {number} [protocol]
 * @returns {{code:number, name:string, zh:string, detail?:string}}
 */
export function classifyInterface(cls, subClass, protocol) {
  const base = USB_CLASS[cls] ?? { name: `Unknown (0x${cls.toString(16)})`, zh: '未知类' };
  const out = { code: cls, name: base.name, zh: base.zh };
  if (cls === 0x03) {
    const sub = HID_SUBCLASS[subClass] ?? `subclass 0x${Number(subClass ?? 0).toString(16)}`;
    const proto = HID_PROTOCOL[protocol];
    out.detail = proto && subClass === 0x01 ? `${sub} / ${proto}` : sub;
  } else if (cls === 0x02 && subClass !== undefined) {
    out.detail = CDC_SUBCLASS[subClass] ?? `subclass 0x${subClass.toString(16)}`;
  } else if (cls === 0x08 && subClass !== undefined) {
    out.detail = MSC_SUBCLASS[subClass] ?? `subclass 0x${subClass.toString(16)}`;
  }
  return out;
}

/** `bDeviceClass` 的分类（设备级，通常是 0x00 表示交给接口）。 */
export function classifyDeviceClass(cls) {
  const base = USB_CLASS[cls] ?? { name: `Unknown (0x${Number(cls ?? 0).toString(16)})`, zh: '未知类' };
  return { code: cls ?? 0, name: base.name, zh: base.zh };
}

/**
 * 从 Windows 侧信息推断「这是什么设备」（人话类型）。
 *
 * 判据优先级：**服务名（驱动）> 描述关键词 > 类名**。服务名最硬——`usbser` 就一定是串口，
 * 不管描述里写的是 "ComPort" 还是 "Silicon Labs CP210x"。
 *
 * @param {{description?:string, className?:string, service?:string, instanceId?:string}} dev
 * @returns {{kind:string, zh:string, evidence:string}}
 */
export function inferKindFromWindows(dev) {
  const desc = String(dev?.description ?? '');
  const cls = String(dev?.className ?? '');
  const svc = String(dev?.service ?? '');
  const iid = String(dev?.instanceId ?? '');
  const probe = `${desc} ${cls}`.toLowerCase();
  const service = svc.toLowerCase();

  /** @type {[RegExp, string, string][]} */
  const byService = [
    [/^usbhub3$|^usbhub$/, 'hub', 'USB 集线器'],
    [/^usbccgp$/, 'composite', '复合设备（子设备各自枚举）'],
    [/^usbstor$|^uaspstor$|^disk$|^storufs$/, 'storage', '大容量存储'],
    [/^usbser$|^ch343ser$|^ch341ser$|^ch342ser$|^ftdibus$|^ftdiport$|^silabser$|^cp210\w*$|^pl2303$|^cdc-acm$/, 'serial', '串口 (CDC/桥接)'],
    [/^hidusb$|^kbdhid$|^mouhid$|^hidbth$/, 'hid', '人机接口 (HID)'],
    [/^usbaudio$|^usbaudio2$/, 'audio', 'USB 音频'],
    [/^usbvideo$/, 'camera', 'USB 摄像头 (UVC)'],
    [/^usbprint$/, 'printer', 'USB 打印机'],
    [/^rtwlanu$|^net\w*$|^usb8023$|^rndismpx$|^mtkbt$/, 'network', 'USB 网络适配器'],
    [/^usbtouchscreen$|^usbmou$/, 'input', 'USB 输入设备'],
    [/^bthusb$|^btwpan$/, 'bluetooth', 'USB 蓝牙'],
  ];
  for (const [re, kind, zh] of byService) {
    if (service && re.test(service)) return { kind, zh, evidence: `服务名 ${svc}` };
  }

  /** @type {[RegExp, string, string][]} */
  const byText = [
    [/root hub|usb hub|集线器/, 'hub', 'USB 集线器'],
    [/composite device|复合设备/, 'composite', '复合设备'],
    [/usb 大容量存储|usb mass storage|u盘|flash disk|external hard|移动硬盘/, 'storage', '大容量存储'],
    [/\(com\d+\)|serial port|串口|uart/, 'serial', '串口 (CDC/桥接)'],
    [/keyboard|键盘/, 'keyboard', '键盘'],
    [/mouse|鼠标|pointing/, 'mouse', '鼠标'],
    [/game ?pad|joystick|手柄/, 'gamepad', '游戏控制器'],
    [/audio|speaker|headset|microphone|声卡|耳机/, 'audio', 'USB 音频'],
    [/camera|webcam|摄像头/, 'camera', 'USB 摄像头 (UVC)'],
    [/printer|打印机/, 'printer', 'USB 打印机'],
    [/bluetooth|蓝牙/, 'bluetooth', 'USB 蓝牙'],
    [/ethernet|网络适配器|wireless|wi-?fi/, 'network', 'USB 网络适配器'],
    [/billboard/, 'billboard', 'USB-C 公告板设备'],
  ];
  for (const [re, kind, zh] of byText) {
    if (re.test(probe)) return { kind, zh, evidence: `描述/类名命中 ${re.source}` };
  }

  if (/^USB\\VID_/i.test(iid)) return { kind: 'usb-device', zh: 'USB 设备（需看描述符细分）', evidence: '实例 ID 前缀 USB\\VID_' };
  if (/^USB\\ROOT_HUB/i.test(iid)) return { kind: 'hub', zh: 'USB 根集线器', evidence: '实例 ID 前缀 USB\\ROOT_HUB' };
  if (/^HID\\/i.test(iid)) return { kind: 'hid', zh: '人机接口 (HID)', evidence: '实例 ID 前缀 HID\\' };
  if (/^PCI\\/i.test(iid)) return { kind: 'controller', zh: '主机控制器 (PCI)', evidence: '实例 ID 前缀 PCI\\' };
  return { kind: 'other', zh: '其它', evidence: '无匹配规则' };
}

/**
 * 单个接口 → 设备类型。
 *
 * 只看接口自己的 class/subclass/protocol：HID 的 Boot 子类 + 协议号能直接分出键盘和鼠标，
 * 这比「设备级 bDeviceClass=0x00」有用得多（后者等于「看接口去」）。
 *
 * @param {{class?:number, subClass?:number, protocol?:number}} iface
 * @returns {{kind:string, zh:string, evidence:string}|undefined}
 */
export function kindOfInterface(iface) {
  const c = iface?.class;
  if (c === undefined) return undefined;
  const sub = iface.subClass;
  const proto = iface.protocol;
  const hx = (n) => `0x${Number(n ?? 0).toString(16).padStart(2, '0')}`;

  if (c === 0x03) {
    if (sub === 0x01 && proto === 0x01) return { kind: 'keyboard', zh: '键盘（Boot 协议）', evidence: 'HID/0x01/proto=Keyboard' };
    if (sub === 0x01 && proto === 0x02) return { kind: 'mouse', zh: '鼠标（Boot 协议）', evidence: 'HID/0x01/proto=Mouse' };
    if (sub === 0x00 && proto === 0x01) return { kind: 'keyboard', zh: '键盘（非 Boot）', evidence: 'HID/0x00/proto=Keyboard' };
    if (sub === 0x00 && proto === 0x02) return { kind: 'mouse', zh: '鼠标（非 Boot）', evidence: 'HID/0x00/proto=Mouse' };
    return { kind: 'hid', zh: '人机接口 (HID)', evidence: `HID subclass=${hx(sub)} proto=${proto ?? '?'}` };
  }
  if (c === 0x02) return { kind: 'serial', zh: '通信 / CDC（常为串口）', evidence: `CDC subclass=${sub ?? '?'}` };
  if (c === 0x08) return { kind: 'storage', zh: '大容量存储', evidence: `MSC subclass=${sub ?? '?'}` };
  if (c === 0x01) return { kind: 'audio', zh: 'USB 音频', evidence: 'bInterfaceClass=0x01' };
  if (c === 0x0e || c === 0x10) return { kind: 'camera', zh: 'USB 视频 / 摄像头', evidence: `bInterfaceClass=${hx(c)}` };
  if (c === 0x07) return { kind: 'printer', zh: 'USB 打印机', evidence: 'bInterfaceClass=0x07' };
  if (c === 0xe0) return { kind: 'bluetooth', zh: '无线 / 蓝牙控制器', evidence: 'bInterfaceClass=0xE0' };
  if (c === 0x0b) return { kind: 'smartcard', zh: '智能卡读卡器', evidence: 'bInterfaceClass=0x0B' };
  if (c === 0xff) return { kind: 'vendor', zh: '厂商自定义设备', evidence: 'bInterfaceClass=0xFF' };
  if (c === 0x00) return undefined; // class 0 的接口是「未报告」，不要当成一种类型
  return { kind: 'usb-device', zh: `USB 设备（class ${hx(c)}）`, evidence: `bInterfaceClass=${hx(c)}` };
}

/**
 * 用描述符（比 Windows 服务名更权威）细分设备类型。
 *
 * 复合设备**不能**一律报「复合设备」——键盘接收器就是「2 个 HID 接口 = 键盘 + 鼠标」，
 * 只说「复合」等于没说。所以逐个接口判类型再汇总：
 *   - 所有接口同类型 → 用该类型，注明有几个接口；
 *   - 混合类型 → `kind:'composite'`，但 `kinds` 里列出真实构成，`zh` 写成「键盘 + 鼠标」。
 *
 * @param {{deviceClass?:number, interfaces?:Array<{class:number, subClass?:number, protocol?:number}>}} desc
 * @returns {{kind:string, zh:string, evidence:string, kinds:string[]}}
 */
export function inferKindFromDescriptors(desc) {
  const dcls = desc?.deviceClass;
  if (dcls === 0x09) return { kind: 'hub', zh: 'USB 集线器', evidence: 'bDeviceClass=0x09', kinds: ['hub'] };

  const ifaces = Array.isArray(desc?.interfaces) ? desc.interfaces : [];

  if (!ifaces.length) {
    if (dcls !== undefined && dcls !== 0x00) {
      const base = classifyDeviceClass(dcls);
      return {
        kind: base.name.toLowerCase().replace(/\s+/g, '-'),
        zh: base.zh,
        evidence: `bDeviceClass=0x${Number(dcls).toString(16).padStart(2, '0')}`,
        kinds: [],
      };
    }
    return { kind: 'usb-device', zh: 'USB 设备（无接口描述符）', evidence: '接口表为空', kinds: [] };
  }

  const per = ifaces.map(kindOfInterface).filter(Boolean);
  const kinds = [...new Set(per.map((k) => k.kind))];
  const labels = [...new Set(per.map((k) => k.zh.replace(/（.*?）/g, '').trim()))];

  if (!kinds.length) {
    return { kind: 'usb-device', zh: `USB 设备（${ifaces.length} 个接口均未报告 class）`, evidence: '接口 class 全为 0x00', kinds: [] };
  }

  if (kinds.length === 1) {
    const one = per[0];
    return ifaces.length === 1
      ? { ...one, kinds }
      : { ...one, zh: `${one.zh}（复合设备，${ifaces.length} 接口）`, evidence: `${one.evidence}；共 ${ifaces.length} 个接口`, kinds };
  }

  const shownLabels = labels.length > 3 ? `${labels.slice(0, 3).join(' + ')} 等 ${labels.length} 类` : labels.join(' + ');
  return {
    kind: 'composite',
    zh: `复合设备：${shownLabels}（${ifaces.length} 接口）`,
    evidence: `bNumInterfaces=${ifaces.length}，接口类型 ${kinds.join('/')}`,
    kinds,
  };
}

/** USB 速度代码（Windows `Device Bus Speed` / `BusSpeed` 枚举）。 */
export const BUS_SPEED = {
  0x00: 'Low-Speed (1.5 Mbps)',
  0x01: 'Full-Speed (12 Mbps)',
  0x02: 'High-Speed (480 Mbps)',
  0x03: 'SuperSpeed (5 Gbps)',
  0x04: 'SuperSpeedPlus (10 Gbps)',
  0x05: 'SuperSpeedPlus (20 Gbps)',
};

/** `Connection Status`（USB_NODE_CONNECTION_INFORMATION.ConnectionStatus，usbioctl.h）。 */
export const CONNECTION_STATUS = {
  0x00: 'NoDeviceConnected',
  0x01: 'DeviceConnected',
  0x02: 'DeviceFailedEnumeration',
  0x03: 'DeviceGeneralFailure',
  0x04: 'DeviceCausedOvercurrent',
  0x05: 'DeviceNotEnoughPower',
  0x06: 'DeviceNotEnoughBandwidth',
  0x07: 'DeviceHubNestedTooDeeply',
  0x08: 'DeviceInLegacyHub',
  0x09: 'DeviceEnumerating',
  0x0a: 'DeviceReset',
};
