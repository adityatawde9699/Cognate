import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Cache every generated chunk/font/icon before the new shell may activate. */
export function offlineShell() {
  let output;
  return {
    name:'cognate-offline-shell', apply:'build',
    configResolved(config) { output=join(config.root,config.build.outDir); },
    closeBundle() {
      const files=[];
      const visit=path => {
        for (const entry of readdirSync(path,{withFileTypes:true})) {
          const file=join(path,entry.name);
          if (entry.isDirectory()) visit(file);
          else if (entry.name!=='sw.js' && !entry.name.endsWith('.map')) files.push(file);
        }
      };
      visit(output); files.sort();
      const digest=createHash('sha256');
      for (const file of files) { digest.update(relative(output,file)); digest.update(readFileSync(file)); }
      const assets=files.map(file=>'/'+relative(output,file).replaceAll('\\','/'));
      const template=readFileSync(join(output,'sw.js'),'utf8');
      writeFileSync(join(output,'sw.js'),template.replace('__BUILD_ID__',digest.digest('hex').slice(0,20)).replace('__PRECACHE_ASSETS__',JSON.stringify(assets)));
    },
  };
}
