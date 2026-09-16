/**
 * 把下载到的官方品牌标志规整成 VS Code 能直接用的 SVG。
 *
 * 只做三件事：统一 viewBox、补齐显式品牌色、丢掉 width/height
 * （Webview 的 <img> 与树图标都由外部尺寸控制，内联尺寸反而会限制缩放）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const SOURCES = [
  {
    file: '.tmp-dv-mysql.svg',
    out: 'media/db-mysql.svg',
    title: 'MySQL',
    fill: '#00618A',
    link: 'https://www.mysql.com/about/legal/logos.html',
  },
  {
    file: '.tmp-dv-pg.svg',
    out: 'media/db-postgresql.svg',
    title: 'PostgreSQL',
    fill: '#336791',
    link: 'https://www.postgresql.org/about/policies/trademarks/',
  },
];

function parseShapes(svg) {
  const shapes = [];
  const re = /<(path|circle|ellipse|rect|polygon)\b([^>]*?)\/?>/g;
  let match;
  while ((match = re.exec(svg)) !== null) {
    const tag = match[1];
    const attrs = match[2];
    const pick = (name) => {
      const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
      return found ? found[1] : undefined;
    };
    shapes.push({
      tag,
      d: pick('d'),
      cx: pick('cx'),
      cy: pick('cy'),
      r: pick('r'),
      rx: pick('rx'),
      ry: pick('ry'),
      x: pick('x'),
      y: pick('y'),
      width: pick('width'),
      height: pick('height'),
      points: pick('points'),
      fill: pick('fill'),
    });
  }
  return shapes;
}

function renderShape(shape, fallbackFill) {
  const parts = [];
  if (shape.tag === 'path') {
    parts.push(`d="${shape.d}"`);
  } else if (shape.tag === 'circle') {
    parts.push(`cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}"`);
  } else if (shape.tag === 'ellipse') {
    parts.push(`cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}"`);
  } else if (shape.tag === 'rect') {
    parts.push(`x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}"`);
    if (shape.rx) {
      parts.push(`rx="${shape.rx}"`);
    }
  } else if (shape.tag === 'polygon') {
    parts.push(`points="${shape.points}"`);
  }
  parts.push(`fill="${shape.fill || fallbackFill}"`);
  return `  <${shape.tag} ${parts.join(' ')} />`;
}

for (const source of SOURCES) {
  const input = path.join(root, source.file);
  const svg = fs.readFileSync(input, 'utf8');
  const viewBox = (/viewBox="([^"]+)"/.exec(svg) || [])[1];
  if (!viewBox) {
    throw new Error(`${source.file} 没有 viewBox，缩放会不可控`);
  }
  const shapes = parseShapes(svg);
  if (shapes.length === 0) {
    throw new Error(`${source.file} 没解析出任何图形元素`);
  }

  const output = [
    '<!--',
    `  ${source.title} 官方标志。`,
    `  商标归 ${source.title} 所有，此处仅用于标识数据库类型：${source.link}`,
    '-->',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img">`,
    ...shapes.map((shape) => renderShape(shape, source.fill)),
    '</svg>',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(root, source.out), output, 'utf8');
  const colors = [...new Set(shapes.map((s) => s.fill || source.fill))];
  console.log(
    `${source.out}: viewBox=${viewBox} 元素=${shapes.length} 颜色=${colors.join(', ')} 字节=${output.length}`,
  );
}
