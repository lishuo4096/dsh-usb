/**
 * 把树/设备对象渲染成人读的文本块。
 *
 * 原则：**有界输出**。本机那个蓝牙复合设备有 187 个子设备、20 个接口，
 * 原样吐出去会把上下文吃光，而且 agent 真正要的往往只是前几个。
 * 所以每个维度都截断并**显式标注还有多少没显示**（`… 另有 175 个`），
 * 让调用方知道该不该再加参数要全量。
 *
 * @module dsh-usb/lib/format
 */

import { kvBlock, padDisplay } from './result.js';
import { labelOf, speedText, vidPidOf } from './usbtree.js';
import { BUS_SPEED, CONNECTION_STATUS } from './usbcodes.js';

const hex = (n, width = 2) => (n === undefined ? '—' : `0x${Number(n).toString(16).toUpperCase().padStart(width, '0')}`);

/**
 * 设备的一行摘要（列表/候选都用它）。
 * @param {{device:any, chain?:string}} row
 */
export function deviceLine(row) {
  const d = row.device ?? row;
  const chain = row.chain ?? d.chain ?? '?';
  return `${padDisplay(chain, 12)} ${(vidPidOf(d) ?? '----:----').padEnd(9)} ${labelOf(d)}`;
}

/**
 * 候选列表（`usb_device` 命中多个、控制类工具要找实例 ID 时用）。
 * @param {Array<any>} rows
 * @param {number} [limit]
 */
export function candidateList(rows, limit = 12) {
  const shown = rows.slice(0, limit);
  const lines = shown.map(
    (r) => `  ${deviceLine(r)}  [${speedText(r.device)}] ${r.device.kindGuess?.zh ?? ''}`.trimEnd(),
  );
  if (rows.length > shown.length) lines.push(`  … 另有 ${rows.length - shown.length} 个未显示`);
  return lines.join('\n');
}

/**
 * 设备详情：描述符 + 接口 + 端点 + 字符串。
 *
 * @param {any} dev
 * @param {{interfaces?:number, endpoints?:number, children?:number, strings?:number, raw?:boolean}} [opts]
 * @returns {{text:string, detail:any}}
 */
export function describeDevice(dev, opts = {}) {
  const { interfaces: maxIf = 10, endpoints: maxEp = 6, children: maxKids = 10, strings: maxStr = 6 } = opts;
  const lines = [];
  const info = dev.info ?? {};
  const desc = dev.descriptor;
  const cfg = dev.config;
  const conn = dev.connection;

  lines.push(`设备：${labelOf(dev)}`);
  lines.push(
    kvBlock([
      ['端口链', dev.portChain ?? dev.chain ?? '—'],
      ['VID:PID', vidPidOf(dev) ?? '—'],
      ['厂商', dev.manufacturerName ?? dev.vendorName ?? '—'],
      ['产品', dev.productName ?? '—'],
      ['序列号', dev.serialNumber ?? '—'],
      ['版本', dev.revision ? `${dev.revision}（bcdDevice ${hex(dev.revisionRaw, 4)}）` : '—'],
      ['速度', dev.speed ?? (conn ? BUS_SPEED[conn.busSpeed] : undefined) ?? '—'],
      ['类型判定', dev.kindGuess ? `${dev.kindGuess.zh}（依据：${dev.kindGuess.evidence}）` : '—'],
      ['实例 ID', dev.instanceId ?? '—'],
      ['Windows 描述', info.description ?? '—'],
      ['类 / 服务', [info.className, info.service].filter(Boolean).join(' / ') || '—'],
      ['驱动', [info.driver, info.driverInf].filter(Boolean).join(' / ') || '—'],
      ['状态', info.status ?? '—'],
      ['电源', info.powerState ?? '—'],
      ['容器 ID', info.containerId ?? '—'],
    ]),
  );

  if (desc) {
    lines.push('');
    lines.push('设备描述符：');
    lines.push(
      kvBlock([
        ['bcdUSB', `${hex(desc.bcdUSB, 4)}${desc.bcdUSBText ? `（${desc.bcdUSBText}）` : ''}`],
        ['类/子类/协议', `${hex(desc.bDeviceClass)} / ${hex(desc.bDeviceSubClass)} / ${hex(desc.bDeviceProtocol)}`],
        ['设备类含义', desc.bDeviceClassNote ?? '—'],
        ['idVendor / idProduct', `${hex(desc.idVendor, 4)} / ${hex(desc.idProduct, 4)}`],
        ['厂商名（描述符）', desc.idVendorName ?? '—'],
        ['bMaxPacketSize0', hex(desc.bMaxPacketSize0)],
        ['配置数', desc.bNumConfigurations ?? '—'],
        ['字符串索引', `iManufacturer=${desc.iManufacturer} iProduct=${desc.iProduct} iSerial=${desc.iSerialNumber}`],
      ]),
    );
  }

  if (cfg) {
    lines.push('');
    lines.push('配置描述符：');
    lines.push(
      kvBlock([
        ['wTotalLength', cfg.wTotalLength ?? '—'],
        ['接口数', cfg.bNumInterfaces ?? '—'],
        ['配置值', cfg.bConfigurationValue ?? '—'],
        ['bmAttributes', `${hex(cfg.bmAttributes)}${cfg.bmAttributesNote ? `（${cfg.bmAttributesNote}）` : ''}`],
        ['自供电', cfg.selfPowered === undefined ? '—' : cfg.selfPowered ? '是' : '否'],
        ['远程唤醒', cfg.remoteWakeup === undefined ? '—' : cfg.remoteWakeup ? '是' : '否'],
        ['MaxPower', cfg.maxPowerMa !== undefined ? `${cfg.maxPowerMa} mA` : `—（原始 ${cfg.maxPowerRaw ?? '?'}）`],
      ]),
    );
  }

  if (dev.interfaces?.length) {
    const ifs = dev.interfaces.slice(0, maxIf);
    lines.push('');
    lines.push(`接口（${dev.interfaces.length} 个${dev.interfaces.length > maxIf ? `，只显示前 ${maxIf}` : ''}）：`);
    for (const i of ifs) {
      const head = `  #${i.bInterfaceNumber ?? '?'} class=${hex(i.class)} ${i.classNote ?? ''} sub=${hex(i.subClass)} proto=${hex(i.protocol)}${i.protocolNote ? `（${i.protocolNote}）` : ''}`;
      lines.push(head.trimEnd());
      if (i.hid) {
        lines.push(
          `      HID: bcdHID=${hex(i.hid.bcdHID, 4)} country=${hex(i.hid.countryCode)} 描述符数=${i.hid.numDescriptors ?? '?'}` +
            (i.hid.reportDescriptorLength ? ` 报告描述符 ${i.hid.reportDescriptorLength} 字节` : ''),
        );
      }
      const eps = (i.endpoints ?? []).slice(0, maxEp);
      for (const ep of eps) {
        const dir = (ep.address & 0x80) === 0x80 ? 'IN' : 'OUT';
        lines.push(
          `      端点 ${hex(ep.address)} ${dir} ${ep.transferTypeNote ?? hex(ep.attributes)} ` +
            `wMaxPacketSize=${ep.wMaxPacketSize ?? '?'} bInterval=${ep.bInterval ?? '?'}${ep.bIntervalNote ? ` (${ep.bIntervalNote})` : ''}`,
        );
      }
      if ((i.endpoints?.length ?? 0) > maxEp) lines.push(`      … 另有 ${i.endpoints.length - maxEp} 个端点`);
    }
    if (dev.interfaces.length > maxIf) lines.push(`  … 另有 ${dev.interfaces.length - maxIf} 个接口`);
  }

  if (dev.stringDescriptors?.length) {
    const ss = dev.stringDescriptors.slice(0, maxStr);
    lines.push('');
    lines.push(`字符串描述符（${dev.stringDescriptors.length} 个）：`);
    for (const s of ss) {
      lines.push(`  [${s.index}] LANG=${s.languageHex ?? '?'} len=${s.length ?? '?'} ${JSON.stringify(s.text ?? '')}`);
    }
    if (dev.stringDescriptors.length > maxStr) lines.push(`  … 另有 ${dev.stringDescriptors.length - maxStr} 个`);
  }

  if (conn) {
    lines.push('');
    lines.push('连接信息：');
    lines.push(
      kvBlock([
        ['连接状态', `${hex(conn.status)}${conn.statusNote ? `（${conn.statusNote}）` : CONNECTION_STATUS[conn.status] ? `（${CONNECTION_STATUS[conn.status]}）` : ''}`],
        ['设备地址', conn.deviceAddress ?? '—'],
        ['总线速度', `${hex(conn.busSpeed)}${conn.busSpeedText ? `（${conn.busSpeedText}）` : ''}`],
        ['是否 hub', conn.isHub ?? '—'],
        ['打开的管道', conn.openPipes ?? '—'],
      ]),
    );
    if (conn.pipes?.length) {
      for (const p of conn.pipes.slice(0, 4)) lines.push(`  ${p}`);
      if (conn.pipes.length > 4) lines.push(`  … 另有 ${conn.pipes.length - 4} 条管道`);
    }
  }

  if (dev.children?.length) {
    const kids = dev.children.slice(0, maxKids);
    lines.push('');
    lines.push(`复合子设备（${dev.children.length} 个）：`);
    for (const k of kids) {
      lines.push(`  ${(k.instanceId ?? '?').padEnd(52)} ${k.description ?? ''} [${k.className ?? '?'}/${k.service ?? '-'}] ${k.status ? `{${k.status}}` : ''}`.trimEnd());
    }
    if (dev.children.length > maxKids) lines.push(`  … 另有 ${dev.children.length - maxKids} 个子设备`);
  }

  if (dev.ports?.length) {
    lines.push('');
    lines.push(`作为 hub 的下行端口（${dev.ports.length} 个）：`);
    for (const p of dev.ports) {
      lines.push(`  端口${p.portNumber} [${p.chain}] ${p.device ? labelOf(p.device) : '（空）'}`);
    }
  }

  return {
    text: lines.join('\n'),
    detail: {
      instanceId: dev.instanceId,
      portChain: dev.portChain ?? dev.chain,
      vidPid: vidPidOf(dev),
      product: dev.productName,
      manufacturer: dev.manufacturerName ?? dev.vendorName,
      serialNumber: dev.serialNumber,
      revision: dev.revision,
      speed: dev.speed,
      kind: dev.kindGuess,
      descriptor: desc,
      config: cfg,
      interfaces: dev.interfaces,
      stringDescriptors: dev.stringDescriptors,
      connection: conn,
      windows: info,
      childCount: dev.children?.length ?? 0,
    },
  };
}

/** 树的一行统计，给 `usb_tree` 的 message 用。 */
export function summaryText(s) {
  const kinds = Object.entries(s.byKind ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join('，');
  return (
    `控制器 ${s.controllers} 个，接着设备的端口 ${s.devices} 个（hub ${s.hubs} 个）。` +
    (kinds ? `\n类型分布：${kinds}` : '') +
    (s.adminPrivileges ? `\nUsbTreeView 报告里 Admin Privileges: ${s.adminPrivileges}` : '')
  );
}
