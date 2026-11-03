// Builds StockSense-Documentation.html from the exported markdown:
// cover page, table of contents, styled body, inline architecture diagram.
// Usage: node build.js <report.md> <diagram.svg> <out.html>
const fs = require("fs");
const { marked } = require("marked");

const [, , mdPath, svgPath, outPath] = process.argv;
let md = fs.readFileSync(mdPath, "utf8");
const svg = fs.readFileSync(svgPath, "utf8");

// Drop the doc's own title and byline; the cover page replaces them.
md = md.replace(/^# [^\n]*\n+/, "").replace(/^Oct \d+, \d{4}[^\n]*\n+/, "");
// Diagram placeholder from the export -> marker we swap for the SVG.
md = md.replace(/(&#91;|\[)embedded content:[^\n]*?\\?\]/, "%%DIAGRAM%%");

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const toc = [];
const renderer = new marked.Renderer();
renderer.heading = ({ text, depth }) => {
  const plain = text.replace(/<[^>]+>/g, "");
  const id = slug(plain);
  if (depth === 2 || depth === 3) toc.push({ depth, id, text: plain });
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};
renderer.table = ({ header, rows }) => {
  const cell = (c, tag) => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ""}>${marked.parseInline(c.text)}</${tag}>`;
  const th = header.map((c) => cell(c, "th")).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`).join("\n");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>\n`;
};
marked.use({ renderer, gfm: true });

let body = marked.parse(md);
body = body.replace(/<p>%%DIAGRAM%%<\/p>/, `<figure class="diagram">${svg}<figcaption>StockSense architecture: seven parts and how they talk</figcaption></figure>`);
// Number top-level sections and add page breaks before each.
let n = 0;
body = body.replace(/<h2 id="([^"]+)">/g, (m, id) => `<h2 id="${id}" class="section"><span class="num">${++n}</span>`);

const tocHtml = toc
  .map((t) => `<li class="d${t.depth}"><a href="#${t.id}">${t.text}</a></li>`)
  .join("\n");

const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const tpl = fs.readFileSync(require("path").join(__dirname, "template.html"), "utf8");
const html = tpl.replace("%%TOC%%", tocHtml).replace("%%BODY%%", body).replace(/%%DATE%%/g, today);
fs.writeFileSync(outPath, html);
console.log(`wrote ${outPath}: ${toc.length} headings, ${n} sections`);
