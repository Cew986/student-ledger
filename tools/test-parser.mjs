/**
 * 零依赖自测：直接从 index.html 抽出 CSV 解析器纯函数，用 samples/ 下的真实格式样例跑一遍。
 * 用法： node tools/test-parser.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function slice(startMark, endMark) {
  const a = html.indexOf(startMark);
  const b = html.indexOf(endMark);
  if (a < 0 || b < 0) throw new Error('找不到标记: ' + startMark);
  return html.slice(a + startMark.length, b);
}

const pure = slice('/* ===== PURE-START ===== */', '/* ===== PURE-END ===== */');

// categoryOf 在 pure 块之外，单独抽出来
const catStart = html.indexOf('function categoryOf(');
const catEnd = html.indexOf('\n}', catStart) + 2;
const categoryOfSrc = html.slice(catStart, catEnd);

const prelude = `
const OTHER_ID = 'other';
const ymd = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
const ym  = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
let _n = 0; const uid = () => 'id' + (++_n);
`;

const src = prelude + pure + '\n' + categoryOfSrc +
  '\nreturn { parseBillText, parseCsvRows, findHeader, decodeSmart, parseAmountCents, parseTime };';

const { parseBillText } = new Function(src)();

const items = [
  { id: 'c1', name: '餐饮',     keywords: ['食堂','美团','饿了么','餐饮','餐厅','外卖','火锅','拉面','咖啡','米粉'] },
  { id: 'c2', name: '水果',     keywords: ['水果','百果园','果园'] },
  { id: 'c3', name: '话费',     keywords: ['中国移动','中国联通','中国电信','话费'] },
  { id: 'c4', name: '交通',     keywords: ['滴滴','地铁','公交','12306','高铁','单车','青桔','哈啰'] },
  { id: 'c5', name: '日用百货', keywords: ['超市','便利店','全家','永辉','日用','菜鸟','快递'] },
  { id: 'c6', name: '学习',     keywords: ['教材','图书','新华书店','打印','知网','网课'] },
  { id: 'c7', name: '娱乐社交', keywords: ['电影','影院','游戏','Steam','腾讯视频','爱奇艺','会员','音乐','演出'] },
  { id: 'c8', name: '机动',     keywords: ['医院','药店','诊所','体检'] },
];
const nameOf = id => (items.find(i => i.id === id) || { name: '其他' }).name;

let fail = 0;
function check(label, cond, extra = '') {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (extra ? '  -> ' + extra : ''));
  if (!cond) fail++;
}

for (const file of ['wechat-sample.csv', 'alipay-sample.csv']) {
  const p = path.join(root, 'samples', file);
  if (!fs.existsSync(p)) { console.log('跳过（不存在）:', file); continue; }
  const buf = fs.readFileSync(p);
  console.log('\n=== ' + file + ' ===');
  let res;
  try {
    const text = new TextDecoder('utf-8').decode(buf);
    res = parseBillText(text, items);
  } catch (e) {
    console.log('  FAIL 解析抛错: ' + e.message + ' (' + (e.code || '') + ')');
    fail++;
    continue;
  }
  console.log('  来源      : ' + res.source + '   表头行: ' + (res.headerIndex + 1));
  console.log('  有效记录  : ' + res.rows.length + '   被过滤: ' + res.filtered.length);
  const byCat = {};
  let sum = 0;
  for (const r of res.rows) {
    if (r.direction !== 'expense') continue;
    byCat[r.categoryId] = (byCat[r.categoryId] || 0) + r.amountCents;
    sum += r.amountCents;
  }
  for (const [k, v] of Object.entries(byCat)) {
    console.log('    ' + nameOf(k).padEnd(6) + ' ¥' + (v / 100).toFixed(2));
  }
  console.log('  支出合计  : ¥' + (sum / 100).toFixed(2));
  console.log('  过滤原因  : ' + res.filtered.map(f => f.why).join(' / '));

  check(file + ' 能识别来源', res.source === (file.startsWith('wechat') ? 'wechat' : 'alipay'), res.source);
  check(file + ' 有有效记录', res.rows.length >= 10, String(res.rows.length));
  check(file + ' 过滤了退款/不计收支', res.filtered.length >= 1, String(res.filtered.length));
  const bad = res.rows.filter(r => !r.month || !r.date || !Number.isFinite(r.amountCents) || r.amountCents <= 0);
  check(file + ' 字段无缺失', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : '');
  const noDup = new Set(res.rows.map(r => r.dedupKey));
  check(file + ' 去重键唯一', noDup.size === res.rows.length, noDup.size + '/' + res.rows.length);
  const comma = res.rows.find(r => (r.product || '').indexOf(',') >= 0);
  check(file + ' 引号内逗号未被拆列', !!comma, comma ? comma.product : '未找到');
  const catAll = res.rows.every(r => r.categoryId);
  check(file + ' 全部归类', catAll);
}

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);
