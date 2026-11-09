import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const files=(await readdir(new URL('../test/',import.meta.url))).filter(x=>x.endsWith('.test.mjs')).map(x=>'test/'+x);
const child=spawn(process.execPath,['--test','--test-concurrency=2',...files],{stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>process.exitCode=code??1);
