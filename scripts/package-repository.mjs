import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { writeZip } from './lib/zip.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const output=path.join(root,'artifacts','github-ready');await fs.mkdir(output,{recursive:true});
const staging=await fs.mkdtemp(path.join(output,'source-')),checkout=path.join(staging,'9sync');await fs.mkdir(checkout,{recursive:true});
const files=['.gitignore','.gitattributes','.dockerignore','.env.example','README.md','CHANGELOG.md','SECURITY.md','CONTRIBUTING.md','package.json','package-lock.json','docker-compose.yml','compose.https.yml','plugin/package.json','plugin/manifest.json','plugin/styles.css','plugin/tsconfig.json','plugin/esbuild.config.mjs','server/package.json','server/tsconfig.json','server/Dockerfile'];
function checkInside(real,name){const relative=path.relative(root,real);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error(`Source points outside the project: ${name}`);}
async function walk(dir){for(const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const name=dir+'/'+entry.name,full=path.join(root,name);checkInside(await fs.realpath(full),name);const stat=await fs.stat(full);if(stat.isDirectory()){if(entry.isSymbolicLink())throw new Error(`Refusing directory link: ${name}`);await walk(name);}else if(stat.isFile())files.push(name);else throw new Error(`Unsupported source entry: ${name}`);}}
for(const dir of ['.github','docs','deploy','scripts','plugin/src','server/src','server/public','server/test'])await walk(dir);
const entries=[];
for(const name of files.sort()){
  if(name!=='.env.example' && /(^|\/)(\.env(?:\..*)?|node_modules|\.git|\.obsidian|backups|artifacts|data)(\/|$)/.test(name))throw new Error(`Private file in source package: ${name}`);
  checkInside(await fs.realpath(path.join(root,name)),name);
  const data=await fs.readFile(path.join(root,name));await fs.mkdir(path.dirname(path.join(checkout,name)),{recursive:true});await fs.writeFile(path.join(checkout,name),data);entries.push({name:`9sync/${name}`,data});
}
const zip=path.join(output,`9sync-github-ready-${version}.zip`);await writeZip(zip,entries);
await fs.writeFile(path.join(output,'SHA256SUMS'),`${crypto.createHash('sha256').update(await fs.readFile(zip)).digest('hex')}  ${path.basename(zip)}\n`);
console.log(`Clean source folder: ${checkout}\nSource ZIP: ${zip}\nFiles: ${files.length}`);
