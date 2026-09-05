'use strict';
/*
 * 纯 Node.js（零依赖）实现《学生餐费核对表》多工作表 xlsx 生成器。
 * 输出格式严格对齐用户模板：
 *   - 第 1 行合并标题：2026年9月黄冈中学附属小学 一 年级  1  班学生餐费核对表
 *   - 第 2 行表头：序号 / 学生姓名 / 用餐类型 / 每日餐费 / 用餐天数 / 总费用 / 备注
 *   - 数据行：总费用 = 当月真实费用；有数据的班逐生列出，无数据班显示提示行
 *   - 合计行：=SUM(...) 自动汇总（含缓存值）
 *   - 底部：班主任审核 / 附小后勤负责人审核 / 日期（留空）
 *
 * 输入 renderMealWorkbook(sheets)：
 *   sheets: [{ title, headerTitle, hasData, rows:[{seq,name,type,dailyFee,days,total,remark}] }]
 * 返回 Buffer（标准 .xlsx / OOXML，STORE 压缩）。
 */

function buildCrc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = buildCrc32Table();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
function colLetter(i) { // 1-based
  let s = '';
  let n = i;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = COL_LETTERS[r] + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function round2(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

/* ---------------------------- 样式定义 ---------------------------- */
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/></numFmts>' +
  '<fonts count="4">' +
  '<font><sz val="11"/><name val="宋体"/></font>' +
  '<font><b/><sz val="15"/><name val="宋体"/></font>' +
  '<font><b/><sz val="11"/><name val="宋体"/></font>' +
  '<font><i/><sz val="10"/><color rgb="FF888888"/><name val="宋体"/></font>' +
  '</fonts>' +
  '<fills count="3">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="11">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/* ---------------------------- 单个工作表 ---------------------------- */
function sheetXml(sh) {
  const colWidths = [6, 12, 12, 11, 10, 13, 26];
  let colsXml = '<cols>';
  colWidths.forEach((w, i) => {
    colsXml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
  });
  colsXml += '</cols>';

  const merges = ['A1:G1'];
  const rows = [];

  // 第 1 行：合并标题
  rows.push('<row r="1" ht="30"><c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">' +
    xmlEscape(sh.headerTitle) + '</t></is></c></row>');

  // 第 2 行：表头
  const headers = ['序号', '学生姓名', '用餐类型', '每日餐费', '用餐天数', '总费用', '备注'];
  let hcells = '';
  headers.forEach((h, j) => {
    hcells += '<c r="' + colLetter(j + 1) + '2" s="2" t="inlineStr"><is><t xml:space="preserve">' +
      xmlEscape(h) + '</t></is></c>';
  });
  rows.push('<row r="2" ht="22">' + hcells + '</row>');

  let lastData = 2;
  if (sh.hasData && sh.rows.length) {
    let r = 3;
    for (const row of sh.rows) {
      const cells = [
        '<c r="A' + r + '" s="3"><v>' + row.seq + '</v></c>',
        '<c r="B' + r + '" s="4" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(row.name) + '</t></is></c>',
        '<c r="C' + r + '" s="3" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(row.type) + '</t></is></c>',
        '<c r="D' + r + '" s="5"><v>' + round2(row.dailyFee) + '</v></c>',
        '<c r="E' + r + '" s="3"><v>' + row.days + '</v></c>',
        '<c r="F' + r + '" s="5"><v>' + round2(row.total) + '</v></c>',
        '<c r="G' + r + '" s="4" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(row.remark || '') + '</t></is></c>'
      ].join('');
      rows.push('<row r="' + r + '" ht="20">' + cells + '</row>');
      r++;
    }
    lastData = r - 1;
    const tr = r;
    const sum = sh.rows.reduce((a, b) => a + round2(b.total), 0);
    let totalCells = '<c r="A' + tr + '" s="6" t="inlineStr"><is><t xml:space="preserve">合计</t></is></c>';
    [1, 2, 3, 4].forEach((j) => { totalCells += '<c r="' + colLetter(j + 1) + tr + '" s="3"/>'; });
    totalCells += '<c r="F' + tr + '" s="7"><f>SUM(F3:F' + lastData + ')</f><v>' + round2(sum) + '</v></c>';
    totalCells += '<c r="G' + tr + '" s="4"/>';
    rows.push('<row r="' + tr + '" ht="20">' + totalCells + '</row>');
    lastData = tr;
  } else {
    // 空模板：提示行（第 3 行合并），合计 ¥0
    merges.push('A3:G3');
    rows.push('<row r="3" ht="20"><c r="A3" s="8" t="inlineStr"><is><t xml:space="preserve">（本班暂无就餐登记数据，可手动填写）</t></is></c></row>');
    const tr = 4;
    let totalCells = '<c r="A' + tr + '" s="6" t="inlineStr"><is><t xml:space="preserve">合计</t></is></c>';
    [1, 2, 3, 4].forEach((j) => { totalCells += '<c r="' + colLetter(j + 1) + tr + '" s="3"/>'; });
    totalCells += '<c r="F' + tr + '" s="7"><v>0</v></c>';
    totalCells += '<c r="G' + tr + '" s="4"/>';
    rows.push('<row r="' + tr + '" ht="20">' + totalCells + '</row>');
    lastData = tr;
  }

  // 底部签名行
  const sig1 = lastData + 2;
  const sig2 = sig1 + 1;
  merges.push('A' + sig1 + ':C' + sig1);
  merges.push('A' + sig2 + ':C' + sig2);
  merges.push('E' + sig2 + ':G' + sig2);
  rows.push('<row r="' + sig1 + '" ht="20"><c r="A' + sig1 + '" s="9" t="inlineStr"><is><t xml:space="preserve">班主任审核：________________</t></is></c></row>');
  rows.push('<row r="' + sig2 + '" ht="20"><c r="A' + sig2 + '" s="9" t="inlineStr"><is><t xml:space="preserve">附小后勤负责人审核：________________</t></is></c>' +
    '<c r="E' + sig2 + '" s="10" t="inlineStr"><is><t xml:space="preserve">日期：        年      月      日</t></is></c></row>');

  const dimension = '<dimension ref="A1:G' + sig2 + '"/>';
  const sheetViews = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  const sheetFormatPr = '<sheetFormatPr defaultRowHeight="18"/>';
  const sheetData = '<sheetData>' + rows.join('') + '</sheetData>';
  const mergeXml = '<mergeCells count="' + merges.length + '">' +
    merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    dimension + sheetViews + sheetFormatPr + colsXml + sheetData + mergeXml + '</worksheet>';
}

/* ---------------------------- ZIP（STORE） ---------------------------- */
function zipSync(files) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = enc(f.name);
    const data = f.data;
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBuf, data]);
    localParts.push(localEntry);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x0021, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += localEntry.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ---------------------------- 组装工作簿 ---------------------------- */
function renderMealWorkbook(sheets) {
  const safeSheets = sheets.map((s, idx) => ({
    name: (s.title || ('Sheet' + (idx + 1))).slice(0, 31),
    xml: sheetXml(s)
  }));
  // 同名处理
  const seen = {};
  safeSheets.forEach((s) => {
    if (seen[s.name]) {
      let i = 2;
      let base = s.name;
      while (seen[base + '(' + i + ')']) i++;
      s.name = base + '(' + i + ')';
    }
    seen[s.name] = true;
  });

  const files = [];
  files.push({ name: '[Content_Types].xml', data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    safeSheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
    '</Types>', 'utf8') });

  files.push({ name: '_rels/.rels', data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>', 'utf8') });

  files.push({ name: 'docProps/core.xml', data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>附小学生餐费核对表</dc:title><dc:creator>班级就餐统计系统</dc:creator>' +
    '</cp:coreProperties>', 'utf8') });

  files.push({ name: 'docProps/app.xml', data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>班级就餐统计系统</Application></Properties>', 'utf8') });

  // workbook.xml
  let sheetTags = safeSheets.map((s, i) =>
    '<sheet name="' + xmlEscape(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('');
  files.push({ name: 'xl/workbook.xml', data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' + sheetTags + '</sheets><calcPr fullCalcOnLoad="1"/></workbook>', 'utf8') });

  // workbook.xml.rels
  let rels = safeSheets.map((s, i) =>
    '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('');
  rels += '<Relationship Id="rId' + (safeSheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>', 'utf8') });

  files.push({ name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') });

  safeSheets.forEach((s, i) => {
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: Buffer.from(s.xml, 'utf8') });
  });

  return zipSync(files);
}

module.exports = { renderMealWorkbook };
