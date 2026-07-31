import { PDFDocument, PDFTextField, PDFCheckBox } from "pdf-lib";
import fs from "fs"; import path from "path";
const dirs = process.argv.slice(2);
const files = dirs.flatMap(d => fs.readdirSync(d).filter(f=>f.endsWith(".pdf")).map(f=>path.join(d,f)));
const out = {};
for (const f of files) {
  try {
    const pdf = await PDFDocument.load(fs.readFileSync(f), { ignoreEncryption: true });
    const fields = pdf.getForm().getFields();
    out[path.basename(f)] = { pages: pdf.getPageCount(), n: fields.length,
      names: fields.map(x => x.getName()) };
  } catch (e) { out[path.basename(f)] = { error: String(e).slice(0,80) }; }
}
fs.writeFileSync("/tmp/acord-fields.json", JSON.stringify(out, null, 1));
for (const [k,v] of Object.entries(out)) console.log(`${k}  pages=${v.pages} fields=${v.n}${v.error?" ERR "+v.error:""}`);
