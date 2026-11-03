# Documentation build

`StockSense-Documentation.pdf` is generated from `report.md` (an export of the
project report doc) plus `template.html` (cover, contents, styles) and
`diagram.svg` (architecture figure).

```bash
cd docs/src
npm init -y && npm i marked@18
node build.js report.md diagram.svg StockSense-Documentation.html
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="..\StockSense-Documentation.pdf" "file:///%CD%/StockSense-Documentation.html"
```
