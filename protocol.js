/**
 * K5Web-like Doppler programming tool - serial protocol module.
 * UMD: 浏览器挂 window.K5WEB.protocol，Node 用 require('./protocol.js')。
 *
 * Implements the F4HWN USB CDC frame protocol used by App/app/uart.c:
 *
 *   frame = [AB CD][Size LE][payload (XOR-obfuscated)][CRC16 LE][DC BA]
 *
 *   - Header ID 0xCDAB (little-endian), Size = payload length
 *   - payload = command struct (its own Header_t ID+Size + data)
 *   - CRC16 = CCITT-FALSE (poly 0x1021, init 0) over the PLAINTEXT payload
 *   - payload is obfuscated with a 16-byte XOR key before transmission
 *   - Footer ID 0xBADC
 *
 * Doppler commands (see App/app/uart.c). Every command carries a slot
 * (0..3) selecting one of the four 16 KB slots:
 *   0x05E0 erase one slot {u8 slot, u8 pad} -> reply 0x05E3 {status}
 *   0x05E1 write satellite block {32B sat, u8 slot, u8 pad} -> reply 0x05E4 {status}
 *   0x05E2 write table entry {u16 index, u16 slot, 16B entry} -> reply 0x05E5 {status}
 *   0x05ED read satellite block {u8 slot, u8 pad} -> reply 0x05F0 {status, slot, pad[2], 32B sat}
 *   status: 0 = OK, 1 = rejected
 */

const OBFUSCATION = [
  0x16, 0x6c, 0x14, 0xe6, 0x2e, 0x91, 0x0d, 0x40,
  0x21, 0x35, 0xd5, 0x40, 0x13, 0x03, 0xe9, 0x80,
];

const CMD = {
  DEV_INFO_REQ: 0x0514,   // 建立会话时间戳 -> reply 0x0515
  DEV_INFO_RESP: 0x0515,
  READ_EEPROM: 0x051b,    // {u16 offset, u8 size, u8 pad, u32 ts} -> reply 0x051c
  READ_EEPROM_RESP: 0x051c,
  WRITE_EEPROM: 0x051d,   // {u16 offset, u8 size, u8 flag=1, u32 ts, data..} -> reply 0x051e
  WRITE_EEPROM_RESP: 0x051e,
  REBOOT: 0x05dd,         // 重启（无回复）
  DOPPLER_ERASE: 0x05e0,
  DOPPLER_WRITE_SAT: 0x05e1,
  DOPPLER_WRITE_ENTRY: 0x05e2,
  REPLY_ERASE: 0x05e3,
  REPLY_WRITE_SAT: 0x05e4,
  REPLY_WRITE_ENTRY: 0x05e5,
  CN_FONT_ERASE: 0x05e6,   // payload {u16 sectorIndex} -> reply 0x05e9
  CN_FONT_WRITE: 0x05e7,   // payload {u32 offset, bytes data} -> reply 0x05ea
  REPLY_FONT_ERASE: 0x05e9,
  REPLY_FONT_WRITE: 0x05ea,
  SET_RTC: 0x05e8,          // payload {u32 unixTime2000 Beijing} -> reply 0x05eb
  REPLY_SET_RTC: 0x05eb,
  CN_FONT_READ: 0x05ec,     // payload {u32 offset} -> reply 0x05ef {u32 offset, u8 data[128]}
  REPLY_CN_FONT_READ: 0x05ef,
  DOPPLER_READ_SAT: 0x05ed, // payload {u8 slot, u8 pad} -> reply 0x05f0
  REPLY_READ_SAT: 0x05f0,   // {u8 status, u8 slot, u8 pad[2], 32B satellite}
};

// 校准区（EEPROM 仿真地址，见 App/driver/eeprom_compat.c：0xB000..0xB200 -> SPI 0x10000）
const CALIB = {
  OFFSET: 0xb000,
  SIZE: 0x200,       // 512 字节
  READ_CHUNK: 128,   // REPLY_051B_t.Data 上限 128
  WRITE_CHUNK: 16,   // 与 UV Studio 写块一致
  TS: 0x11223344,    // 会话时间戳（与 tools/k5web/probe_radio.py 一致）
};

// 字库区参数（必须与 App/app/cnfont.h 一致）
const CN_FONT = {
  GLYPH_SIZE: 32,          // 16×16 源字形，与白头佬共享字库一致
  GLYPH_COUNT: 8192,       // 截断到共享区 0xA0000..0xE0000 容量
  get FLASH_SIZE() { return this.GLYPH_SIZE * this.GLYPH_COUNT; }, // 262,144
  get SECTOR_COUNT() { return Math.ceil(this.FLASH_SIZE / 0x1000); }, // 64
  // 每帧数据量上限由固件 256B 接收环形缓冲决定：整帧 = 数据 + 偏移4 + 命令头4 + CRC2 + 帧头尾4 = CHUNK + 16，
  // 必须 ≤ 255。若整帧恰好 256B 填满环形缓冲，写指针回卷后与读指针重合，
  // 固件 (uart.c UART_IsCommandAvailable) 会误判"缓冲空"而丢弃整帧 → 主机回复超时。
  CHUNK: 232,
};

// MR 信道存储参数（EEPROM 仿真地址，经 eeprom_compat.c 1:1 映射到 SPI Flash）
const CHAN = {
  FREQ_BASE: 0x0000,   // MR 信道频率/参数区，1024 信道 × 16 字节
  NAME_BASE: 0x4000,   // MR 信道名称区，1024 信道 × 16 字节
  ATTR_BASE: 0x8000,   // MR + VFO 属性区，(1024+7) × 2 字节
  SIZE: 16,            // 单个信道频率区长度
  NAME_SIZE: 16,       // 单个信道名称长度
  ATTR_SIZE: 2,        // 单个信道属性长度
  ATTR_ALIGN: 8,       // 属性区按 8 字节块读写（固件 EEPROM_WriteBuffer 固定 8 字节）
  MAX_COUNT: 1024,     // 最大 MR 信道数
};

// CTCSS / DCS 选项表（索引与固件 dcs.c 一致）
const CTCSS_OPTIONS = [
  670, 693, 719, 744, 770, 797, 825, 854, 885, 915,
  948, 974, 1000, 1035, 1072, 1109, 1148, 1188, 1230, 1273,
  1318, 1365, 1413, 1462, 1514, 1567, 1598, 1622, 1655, 1679,
  1713, 1738, 1773, 1799, 1835, 1862, 1899, 1928, 1966, 1995,
  2035, 2065, 2107, 2181, 2257, 2291, 2336, 2418, 2503, 2541,
];

const DCS_OPTIONS = [
  0x0013, 0x0015, 0x0016, 0x0019, 0x001A, 0x001E, 0x0023, 0x0027,
  0x0029, 0x002B, 0x002C, 0x0035, 0x0039, 0x003A, 0x003B, 0x003C,
  0x004C, 0x004D, 0x004E, 0x0052, 0x0055, 0x0059, 0x005A, 0x005C,
  0x0063, 0x0065, 0x006A, 0x006D, 0x006E, 0x0072, 0x0075, 0x007A,
  0x007C, 0x0085, 0x008A, 0x0093, 0x0095, 0x0096, 0x00A3, 0x00A4,
  0x00A5, 0x00A6, 0x00A9, 0x00AA, 0x00AD, 0x00B1, 0x00B3, 0x00B5,
  0x00B6, 0x00B9, 0x00BC, 0x00C6, 0x00C9, 0x00CD, 0x00D5, 0x00D9,
  0x00DA, 0x00E3, 0x00E6, 0x00E9, 0x00EE, 0x00F4, 0x00F5, 0x00F9,
  0x0109, 0x010A, 0x010B, 0x0113, 0x0119, 0x011A, 0x0125, 0x0126,
  0x012A, 0x012C, 0x012D, 0x0132, 0x0134, 0x0135, 0x0136, 0x0143,
  0x0146, 0x014E, 0x0153, 0x0156, 0x015A, 0x0166, 0x0175, 0x0186,
  0x018A, 0x0194, 0x0197, 0x0199, 0x019A, 0x01AC, 0x01B2, 0x01B4,
  0x01C3, 0x01CA, 0x01D3, 0x01D9, 0x01DA, 0x01DC, 0x01E3, 0x01EC,
];

const CODE_TYPE = { OFF: 0, CTCSS: 1, DCS: 2, DCS_REV: 3 };
const MODULATION = { FM: 0, AM: 1, USB: 2 };
const TX_DIR = { OFF: 0, ADD: 1, SUB: 2 };
const BANDWIDTH = { WIDE: 0, NARROW: 1 };
const POWER = { USER: 0, LOW1: 1, LOW2: 2, LOW3: 3, LOW4: 4, LOW5: 5, MID: 6, HIGH: 7 };
const STEP = {
  "2.5": 0, "5": 1, "6.25": 2, "10": 3, "12.5": 4, "25": 5, "8.33": 6,
  "0.01": 7, "0.05": 8, "0.1": 9, "0.25": 10, "0.5": 11, "1": 12, "1.25": 13,
  "9": 14, "15": 15, "20": 16, "30": 17, "50": 18, "100": 19, "125": 20,
  "200": 21, "250": 22, "500": 23,
};

// ==================== 叮咚鸡信道表格式兼容层 ====================
// 叮咚鸡（国产写频软件）导出的信道表（sheet "MR信道"）表头：
//   信道号,接收频率_MHz,功率,接收数字亚音,接收模拟亚音,发射数字亚音,发射模拟亚音,
//   频差方向,频差频率_MHz,调制模式,步进,信道列表,信道名
// 导入导出均按此格式，同时向后兼容 k5web 旧版 11 列格式。

const DD_HEADERS = [
  "信道号", "接收频率_MHz", "功率", "接收数字亚音", "接收模拟亚音",
  "发射数字亚音", "发射模拟亚音", "频差方向", "频差频率_MHz", "调制模式",
  "步进", "信道列表", "信道名",
];

const POWER_NAMES = ["USER", "LOW1", "LOW2", "LOW3", "LOW4", "LOW5", "MID", "HIGH"];
const MODULATION_NAMES = ["FM", "AM", "USB"];
const DD_DIR_NAMES = ["关闭", "+", "−"]; // 与叮咚鸡一致：SUB 用全角减号 U+2212

// 固件步进索引 → kHz 值（STEP 的反查表，单位 kHz；"1k" = 1 kHz = 索引 12）
const STEP_INDEX_TO_KHZ = [];
for (const [khz, idx] of Object.entries(STEP)) STEP_INDEX_TO_KHZ[idx] = khz;

/** 叮咚鸡功率文本 → 固件 POWER 枚举（MID→6, HIGH→7, LOWn→1..5, USER→0），无法识别返回 null */
function parseDdPower(value) {
  const v = String(value == null ? "" : value).trim().toUpperCase();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Math.min(parseInt(v, 10), 7);
  const m = v.match(/^LOW(\d)?$/);
  if (m) return m[1] ? Math.min(parseInt(m[1], 10), 5) : 1;
  if (v === "MID") return 6;
  if (v === "HIGH") return 7;
  if (v === "USER") return 0;
  return null;
}

/** 叮咚鸡"数字亚音/模拟亚音"两列 → 固件亚音 {code, codeType}。
 *  模拟列填 "88.5Hz"（CTCSS），数字列填 "023"/"D023"/"I023"（DCS）。
 *  两列同时有值时以数字列（DCS）为准并置 conflict 标记。 */
function parseDdTone(digital, analog) {
  const d = String(digital == null ? "" : digital).trim();
  const a = String(analog == null ? "" : analog).trim();
  const isOff = (s) => !s || /^(OFF|无|关闭|0)$/i.test(s);
  let code = 0, codeType = CODE_TYPE.OFF, conflict = false;

  if (!isOff(a)) {
    // 模拟列：带 Hz 后缀或纯小数 → CTCSS
    const m = a.replace("Hz", "").replace("hz", "").trim();
    const hz = Math.round(parseFloat(m) * 10);
    if (isFinite(hz) && hz > 0) { code = ctcssIndex(hz); codeType = CODE_TYPE.CTCSS; }
  }
  if (!isOff(d)) {
    const m = d.match(/^[DI]?(\d{3})$/i);
    if (m) {
      if (codeType !== CODE_TYPE.OFF) conflict = true;
      code = dcsIndex(parseInt(m[1], 8));
      codeType = /^I/i.test(d) ? CODE_TYPE.DCS_REV : CODE_TYPE.DCS;
    }
  }
  return { code, codeType, conflict };
}

/** 叮咚鸡频差方向文本 → TX_DIR（"关闭"→0，"+"/"上差"→1，"−"(全/半角)/"下差"→2） */
function parseDdDir(value) {
  const v = String(value == null ? "" : value).trim();
  if (!v || /^(关闭|无|OFF|0)$/i.test(v)) return TX_DIR.OFF;
  if (v === "+" || v === "1" || /^(上差|加)$/.test(v)) return TX_DIR.ADD;
  if (/^[−\-－]$/.test(v) || v === "2" || /^(下差|减)$/.test(v)) return TX_DIR.SUB;
  return TX_DIR.OFF;
}

/** 叮咚鸡调制模式文本 → MODULATION（FM→0，AM→1，USB→2；纯数字直接取） */
function parseDdMod(value) {
  const v = String(value == null ? "" : value).trim().toUpperCase();
  if (/^\d+$/.test(v)) { const n = parseInt(v, 10); return n >= 0 && n <= 2 ? n : 0; }
  if (v === "AM") return 1;
  if (v === "USB") return 2;
  return 0; // FM（含未知值）
}

/** 叮咚鸡步进文本（"1k"/"12.5k"/"25k"…）→ 固件 STEP 索引，未知时默认 12.5k(4) */
function parseDdStep(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase().replace(/k(hz)?$/, "").replace(",", ".");
  const khz = parseFloat(v);
  if (isNaN(khz)) return 4;
  let best = 4, bestDiff = Infinity;
  for (const [k, idx] of Object.entries(STEP)) {
    const diff = Math.abs(parseFloat(k) - khz);
    if (diff < bestDiff) { bestDiff = diff; best = idx; }
  }
  return best;
}

/** 固件 STEP 索引 → 叮咚鸡步进文本（"12.5k"） */
function ddStepName(stepIndex) {
  const khz = STEP_INDEX_TO_KHZ[stepIndex];
  return khz !== undefined ? khz + "k" : "12.5k";
}

/** 固件亚音 → 叮咚鸡两列文本：CTCSS 进模拟列（"88.5Hz"），DCS 进数字列（"023"/"I023"），无则 "OFF" */
function toneToDdColumns(code, type) {
  if (type === CODE_TYPE.CTCSS) {
    const tenth = CTCSS_OPTIONS[code];
    return { digital: "OFF", analog: tenth !== undefined ? (tenth / 10).toFixed(1) + "Hz" : "OFF" };
  }
  if (type === CODE_TYPE.DCS || type === CODE_TYPE.DCS_REV) {
    const c = DCS_OPTIONS[code];
    return {
      digital: c === undefined ? "OFF" : (type === CODE_TYPE.DCS_REV ? "I" : "") + c.toString(8).padStart(3, "0"),
      analog: "OFF",
    };
  }
  return { digital: "OFF", analog: "OFF" };
}

/** 判断一行是否为叮咚鸡表头（按列名，不依赖列位置） */
function isDdHeader(cols) {
  return cols.length >= 3 && cols.includes("接收频率_MHz") && cols.includes("信道名");
}

/** 判断一行是否为 k5web 旧版表头（信道号,名称,接收频率,…） */
function isLegacyHeader(cols) {
  return cols.length >= 3 && cols.includes("名称") && cols.includes("接收频率") && !cols.includes("接收频率_MHz");
}

/** 叮咚鸡表头 → 列名索引映射（缺列返回 -1，调用方按 -1 跳过该字段） */
function ddColumnIndex(cols) {
  const map = {};
  for (const [i, c] of cols.entries()) map[String(c).trim()] = i;
  return {
    ch: map["信道号"] ?? -1,
    rx: map["接收频率_MHz"] ?? -1,
    power: map["功率"] ?? -1,
    rxDigital: map["接收数字亚音"] ?? -1,
    rxAnalog: map["接收模拟亚音"] ?? -1,
    txDigital: map["发射数字亚音"] ?? -1,
    txAnalog: map["发射模拟亚音"] ?? -1,
    dir: map["频差方向"] ?? -1,
    offset: map["频差频率_MHz"] ?? -1,
    mod: map["调制模式"] ?? -1,
    step: map["步进"] ?? -1,
    scanlist: map["信道列表"] ?? -1,
    name: map["信道名"] ?? -1,
  };
}

/** 从字符串自动推断亚音类型：含小数点→CTCSS；3 位数字/Dxxx/Ixxx→DCS；空→OFF */
function autoToneInput(value) {
  const s = (value || "").trim();
  if (!s) return { code: 0, codeType: CODE_TYPE.OFF };
  if (/[.,]/.test(s) || (/^\d{2,3}$/.test(s) && parseInt(s, 10) > 100)) {
    const hz = Math.round(parseFloat(s.replace(",", ".")) * 10);
    return { code: ctcssIndex(hz), codeType: CODE_TYPE.CTCSS };
  }
  const m = s.match(/^[DI]?(\d{3})$/i);
  if (m) {
    const idx = dcsIndex(parseInt(m[1], 8));
    const codeType = /^I/i.test(s) ? CODE_TYPE.DCS_REV : CODE_TYPE.DCS;
    return { code: idx, codeType };
  }
  return { code: 0, codeType: CODE_TYPE.OFF };
}

/**
 * 把行数组解析为统一的信道记录数组（兼容叮咚鸡 13 列 / k5web 旧版 11 列 / 无表头）。
 * 每行记录: { ch(0-based), name, rx10, diff10(带符号频差), rxCode, rxCodeType,
 *            txCode, txCodeType, modulation, bandwidth, power, step, scanlist }
 * @param {Array<Array<string>>} rows 二维数组（不含空行）
 * @returns {{rows: Array<Object>, format: string, warnings: Array<string>}}
 */
function parseChannelRows(rows) {
  let headerIdx = -1, dd = false;
  for (let i = 0; i < rows.length; i++) {
    if (isDdHeader(rows[i])) { headerIdx = i; dd = true; break; }
    if (isLegacyHeader(rows[i])) { headerIdx = i; break; }
  }

  const out = [];
  const warnings = [];
  if (headerIdx >= 0 && dd) {
    // ---- 叮咚鸡格式：按列名取列 ----
    const idx = ddColumnIndex(rows[headerIdx]);
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const c = rows[i];
      const get = (j) => (j >= 0 && c[j] !== undefined ? String(c[j]) : "");
      const ch = parseInt(get(idx.ch), 10) - 1;
      const rx = parseFloat(get(idx.rx));
      if (isNaN(ch) || isNaN(rx)) continue;
      const dir = parseDdDir(get(idx.dir));
      const off = Math.round((parseFloat(get(idx.offset)) || 0) * 100000);
      const rxTone = parseDdTone(get(idx.rxDigital), get(idx.rxAnalog));
      const txTone = parseDdTone(get(idx.txDigital), get(idx.txAnalog));
      if (rxTone.conflict || txTone.conflict)
        warnings.push(`信道 ${ch + 1}：数字/模拟亚音两列同时有值，以 DCS 为准`);
      out.push({
        ch, name: get(idx.name),
        rx10: Math.round(rx * 100000),
        diff10: dir === TX_DIR.ADD ? off : dir === TX_DIR.SUB ? -off : 0,
        rxCode: rxTone.code, rxCodeType: rxTone.codeType,
        txCode: txTone.code, txCodeType: txTone.codeType,
        modulation: parseDdMod(get(idx.mod)),
        bandwidth: 0, // 叮咚鸡格式无带宽列，默认宽带
        power: parseDdPower(get(idx.power)) ?? 7,
        step: parseDdStep(get(idx.step)),
        scanlist: 0,
      });
    }
  } else {
    // ---- 旧版格式：按列位置（表头行或无表头均可） ----
    const start = headerIdx >= 0 ? headerIdx + 1 : 0;
    for (let i = start; i < rows.length; i++) {
      const c = rows[i];
      if (c.length < 4) continue;
      const ch = parseInt(c[0], 10) - 1;
      const rx = parseFloat(c[2]);
      if (isNaN(ch) || isNaN(rx)) continue;
      const tx = parseFloat(c[3]);
      const rx10 = Math.round(rx * 100000);
      let diff10;
      if (!isNaN(tx) && tx > 0) diff10 = Math.round(tx * 100000) - rx10;
      else {
        const d = parseDdDir(c[9] || "");
        const off = Math.round((parseFloat(c[10]) || 0) * 100000);
        diff10 = d === TX_DIR.ADD ? off : d === TX_DIR.SUB ? -off : 0;
      }
      const rxTone = autoToneInput(c[4] || "");
      const txTone = autoToneInput(c[5] || "");
      out.push({
        ch, name: c[1] || "",
        rx10, diff10,
        rxCode: rxTone.code, rxCodeType: rxTone.codeType,
        txCode: txTone.code, txCodeType: txTone.codeType,
        modulation: parseInt(c[8] || "0", 10),
        bandwidth: parseInt(c[6] || "0", 10),
        power: parseInt(c[7] || "7", 10),
        step: 4, scanlist: 0,
      });
    }
  }
  return { rows: out, format: dd ? "叮咚鸡" : "旧版", warnings };
}

// 频率 → 频段（与固件 FREQUENCY_Band_t 一致，单位 10Hz）
function bandFromFrequency(freq10Hz) {
  // 50~76 MHz
  if (freq10Hz >= 5000000 && freq10Hz < 7600000) return 0;
  // 108~137 MHz
  if (freq10Hz >= 10800000 && freq10Hz < 13700000) return 1;
  // 137~174 MHz
  if (freq10Hz >= 13700000 && freq10Hz < 17400000) return 2;
  // 174~350 MHz
  if (freq10Hz >= 17400000 && freq10Hz < 35000000) return 3;
  // 350~400 MHz
  if (freq10Hz >= 35000000 && freq10Hz < 40000000) return 4;
  // 400~470 MHz
  if (freq10Hz >= 40000000 && freq10Hz <= 47000000) return 5;
  // 470~600 MHz
  if (freq10Hz > 47000000 && freq10Hz <= 60000000) return 6;
  return 5; // 默认 UHF
}

/** 查找 CTCSS 值在表中的索引（值单位为 0.1 Hz），找不到返回 0 */
function ctcssIndex(ctcssTenthHz) {
  const v = Math.round(ctcssTenthHz);
  const idx = CTCSS_OPTIONS.indexOf(v);
  return idx >= 0 ? idx : 0;
}

/** 查找 DCS 值在表中的索引，找不到返回 0 */
function dcsIndex(dcsCode) {
  const v = Math.round(dcsCode);
  const idx = DCS_OPTIONS.indexOf(v);
  return idx >= 0 ? idx : 0;
}

/**
 * 构建 MR 信道频率区 16 字节数据块。
 * 字段 layout 与 SETTINGS_SaveChannel() 写入 SPI Flash 的一致。
 * 注意：offset 4 存的是“频差值”（TX_OFFSET_FREQUENCY，10Hz 单位），
 * 不是绝对发射频率；实际发射频率由固件按 接收频率±频差 计算
 * （radio.c RADIO_ApplyOffset），方向由 byte11 低半字节 txDir 决定。
 * @param {Object} p
 *   rxFreq10Hz, txOffsetFreq10Hz, rxCodeType, rxCode, txCodeType, txCode,
 *   modulation, txDir, bandwidth, power, txLock, bcl, freqReverse, pttId, step
 */
function buildChannelBlock(p) {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, p.rxFreq10Hz, true);
  dv.setUint32(4, p.txOffsetFreq10Hz, true);
  buf[8] = p.rxCode;
  buf[9] = p.txCode;
  buf[10] = ((p.txCodeType & 0x0F) << 4) | (p.rxCodeType & 0x0F);
  buf[11] = ((p.modulation & 0x0F) << 4) | (p.txDir & 0x0F);
  buf[12] = ((p.txLock & 1) << 6) | ((p.bcl & 1) << 5) | ((p.power & 7) << 2) |
            ((p.bandwidth & 1) << 1) | (p.freqReverse & 1);
  buf[13] = ((p.pttId & 7) << 1);
  buf[14] = p.step;
  buf[15] = 0;
  return buf;
}

/** 构建 MR 信道属性 2 字节（ChannelAttributes_t） */
function buildChannelAttributes({ band, compander = 0, exclude = 0, scanlist = 0 }) {
  const val = (band & 0x07) | ((compander & 0x03) << 3) | ((exclude & 1) << 7) | ((scanlist & 0xFF) << 8);
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, val, true);
  return buf;
}

// 固件刷写消息号（bootloader 协议，参考 Apache-2.0 的 uvtools2/js/flash.js，
// https://github.com/armel/armel.github.io/tree/master/uvtools2 ）
const FLASH_MSG = {
  NOTIFY_DEV_INFO: 0x0518, // bootloader 上电后持续广播: UID16 + 版本ASCII
  PROG_FW: 0x0519,         // 分页编程
  PROG_FW_RESP: 0x051a,    // 每页 ACK: 回显页号 + 错误码(0=成功)
  NOTIFY_BL_VER: 0x0530,   // 握手回执: 版本字符串前 4 个 ASCII
  PAGE_SIZE: 256,
  MIN_BL_VERSION: [7, 0, 7], // bootloader 最低版本 7.00.07
  APP_MAX_SIZE: 118 * 1024,  // 应用区上限 0x08002800..0x08020000
};

/** CRC-16/CCITT-FALSE, matches App/driver/crc.c CRC_Calculate(). */
function crc16(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** CRC-8 (poly 0x07), matches App/app/doppler.c DOPPLER_Crc8(). */
function crc8(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** Builds a SET_RTC payload: 4-byte little-endian uint32 (2000-epoch Beijing seconds). */
function buildRtcTimePayload(unix2000) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, unix2000 >>> 0, true);
  return buf;
}

/** Builds a DOPPLER_Satellite_t block (32 bytes) as stored at 0x1E8000.
 *  Layout (must match doppler.h, no padding):
 *    0..3 start_unix u32 | 4..13 name | 14..19 start_time | 20..25 end_time
 *    26..27 sum_time u16 | 28..29 send_ctcss u16 | 30 crc8 | 31 reserved */
function buildSatelliteBlock({ name, startTime, endTime, sumTime, sendCtcss, startUnix }) {
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  const enc = new TextEncoder();
  dv.setUint32(0, startUnix, true);
  const nb = enc.encode(name.slice(0, 9));
  buf.set(nb, 4); // name[13] stays 0 -> valid marker
  buf.set(startTime, 14); // year(2000-based)/month/day/hour/minute/second
  buf.set(endTime, 20);
  dv.setUint16(26, sumTime, true);
  dv.setUint16(28, sendCtcss, true); // Hz/10, 0 = none
  buf[30] = crc8(buf.subarray(0, 30));
  buf[31] = 0;
  return buf;
}

/** Builds a DOPPLER_Entry_t (16 bytes): uplink/downlink in 10 Hz units,
 *  plus altitude (km), distance (km), azimuth (0.1 deg), elevation (0.1 deg). */
function buildEntry(uplink10Hz, downlink10Hz, altitudeKm = 0, distanceKm = 0, azimuthDeg = 0, elevationDeg = 0) {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, uplink10Hz, true);
  dv.setUint32(4, downlink10Hz, true);
  dv.setUint16(8, Math.max(0, Math.round(altitudeKm)), true);
  dv.setUint16(10, Math.max(0, Math.round(distanceKm)), true);
  let az = Math.round(azimuthDeg * 10) % 3600;
  if (az < 0) az += 3600;
  dv.setUint16(12, az, true);
  dv.setInt16(14, Math.round(elevationDeg * 10), true);
  return buf;
}

/** Builds a full command frame for the radio. */
function buildFrame(commandId, payload) {
  // body = command struct (its own Header_t ID+Size + data)
  const p = new Uint8Array(4 + payload.length);
  const dv = new DataView(p.buffer);
  dv.setUint16(0, commandId, true);
  dv.setUint16(2, payload.length, true);
  p.set(payload, 4);

  const crc = crc16(p);

  // CRITICAL: the firmware decrypts Size+2 bytes = body + CRC (uart.c:802),
  // so the CRC MUST be included in the obfuscated region.
  const enc = new Uint8Array(p.length + 2);
  enc.set(p, 0);
  const edv = new DataView(enc.buffer);
  edv.setUint16(p.length, crc, true);

  // 帧长 = 帧头4 + 加密区(命令体+CRC) + 帧尾2，不多不少（多出的字节会被固件当噪声丢弃）
  const frame = new Uint8Array(6 + enc.length);
  frame[0] = 0xab; frame[1] = 0xcd;
  frame[2] = p.length & 0xff; frame[3] = (p.length >> 8) & 0xff; // Size = body length only
  for (let i = 0; i < enc.length; i++) frame[4 + i] = enc[i] ^ OBFUSCATION[i % 16];
  frame[4 + enc.length] = 0xdc;
  frame[5 + enc.length] = 0xba;
  return frame;
}

/** Parses a reply frame (plaintext payload already accumulated). */
function parseReply(payload) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const id = dv.getUint16(0, true);
  const size = dv.getUint16(2, true);
  const status = payload.length >= 5 ? payload[4] : 0xff;
  return { id, size, status };
}

/** Builds a bootloader-protocol frame (固件刷写用).
 *  与 buildFrame 同帧格式，差异：消息体长度为奇数时补 1 字节凑偶
 *  （uvtools2 makePacket 的行为，刷机消息均为偶数长度，此处仅作忠实兼容）。 */
function buildFlashFrame(msgType, data) {
  const pad = (4 + data.length) % 2 ? 1 : 0;
  const body = new Uint8Array(4 + data.length + pad);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, msgType, true);
  dv.setUint16(2, data.length, true);
  body.set(data, 4);

  const crc = crc16(body);
  const enc = new Uint8Array(body.length + 2);
  enc.set(body, 0);
  new DataView(enc.buffer).setUint16(body.length, crc, true);

  const frame = new Uint8Array(6 + enc.length);
  frame[0] = 0xab; frame[1] = 0xcd;
  frame[2] = body.length & 0xff; frame[3] = (body.length >> 8) & 0xff;
  for (let i = 0; i < enc.length; i++) frame[4 + i] = enc[i] ^ OBFUSCATION[i % 16];
  frame[4 + enc.length] = 0xdc;
  frame[5 + enc.length] = 0xba;
  return frame;
}

/** 构建一页固件编程消息: timestamp u32 | pageIndex u16 | pageCount u16 | 保留4B | 256B 数据 */
function buildFwPage(timestamp, pageIndex, pageCount, pageData) {
  const buf = new Uint8Array(4 + 4 + 4 + FLASH_MSG.PAGE_SIZE); // 268
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, timestamp >>> 0, true);
  dv.setUint16(4, pageIndex, true);
  dv.setUint16(6, pageCount, true);
  // 8..11 保留，全 0
  buf.set(pageData, 12);
  return buf;
}

/** 解析 0x0518 设备信息广播: data[0..15]=UID, data[16..31]=版本 ASCII(0 结尾) */
function parseDevInfo(payload) {
  if (payload.length < 4 + 16) return null;
  const data = payload.subarray(4);
  const uid = Array.from(data.subarray(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("");
  let ver = "";
  for (let i = 16; i < data.length && data[i] !== 0; i++) ver += String.fromCharCode(data[i]);
  return { uid, version: ver };
}

/** 版本比较: "7.00.07" >= [7,0,7] ? */
function blVersionOK(verStr) {
  const m = verStr.trim().match(/(\d+)\.(\d+)\.?(\d+)?/);
  if (!m) return false;
  const v = [+m[1], +m[2], +(m[3] || 0)];
  const min = FLASH_MSG.MIN_BL_VERSION;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/** Frame decoder: feeds bytes, yields complete plaintext payloads. */
class FrameDecoder {
  constructor() {
    this.buf = new Uint8Array(0);
  }
  push(chunk) {
    const out = [];
    this.buf = concat(this.buf, new Uint8Array(chunk));
    for (;;) {
      // find header
      let h = -1;
      for (let i = 0; i < this.buf.length - 1; i++) {
        if (this.buf[i] === 0xab && this.buf[i + 1] === 0xcd) { h = i; break; }
      }
      if (h < 0) { this.buf = this.buf.slice(-1); break; } // keep 1 byte for partial header
      if (h > 0) this.buf = this.buf.slice(h);
      if (this.buf.length < 6) break; // need size + first payload bytes
      const size = this.buf[2] | (this.buf[3] << 8);
      const total = 8 + size;
      if (this.buf.length < total) break;
      // footer check
      if (this.buf[4 + size + 2] !== 0xdc || this.buf[4 + size + 3] !== 0xba) {
        this.buf = this.buf.slice(2); // resync
        continue;
      }
      // 回复帧的 2 字节是 Padding (加密填充), 不是 CRC (uart.c SendReply) - 不校验
      const plain = new Uint8Array(size);
      for (let i = 0; i < size; i++) plain[i] = this.buf[4 + i] ^ OBFUSCATION[i % 16];
      out.push(plain);
      this.buf = this.buf.slice(total);
    }
    return out;
  }
}

function concat(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}


// ---- UMD 导出（浏览器 window.K5WEB / Node module.exports） ----
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.K5WEB = root.K5WEB || {};
    root.K5WEB.protocol = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  return {
    OBFUSCATION, CMD, CN_FONT, FLASH_MSG, CALIB, CHAN, CTCSS_OPTIONS, DCS_OPTIONS,
    CODE_TYPE, MODULATION, TX_DIR, BANDWIDTH, POWER, STEP,
    DD_HEADERS, POWER_NAMES, MODULATION_NAMES, DD_DIR_NAMES,
    crc16, crc8,
    buildSatelliteBlock, buildEntry, buildFrame, parseReply, FrameDecoder,
    buildFlashFrame, buildFwPage, parseDevInfo, blVersionOK,
    bandFromFrequency, ctcssIndex, dcsIndex, buildChannelBlock, buildChannelAttributes,
    buildRtcTimePayload,
    parseDdPower, parseDdTone, parseDdDir, parseDdMod, parseDdStep,
    ddStepName, toneToDdColumns, isDdHeader, isLegacyHeader, ddColumnIndex,
    autoToneInput, parseChannelRows,
  };
});
