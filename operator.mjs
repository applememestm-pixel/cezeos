import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { backup } from 'node:sqlite';
import { openStore } from './store.mjs';
import { createGovernance } from './governance.mjs';

const data=resolve(process.env.CEZEOS_DATA_DIR||'data');
const [command,...args]=process.argv.slice(2);
if (!['backup','set-triumvirs'].includes(command)) {
  console.error('node operator.mjs backup <file> | set-triumvirs @aqua_nick1 @aqua_nick2 @aqua_nick3');
  process.exit(2);
}
mkdirSync(data,{recursive:true});
const db=openStore(resolve(data,'cezeos.sqlite'));
try {
  if (command==='backup') {
    if (args.length!==1) throw new Error('Укажите путь для резервной копии.');
    const destination=resolve(args[0]);
    mkdirSync(dirname(destination),{recursive:true});
    const key=resolve(data,'region-key.pem');
    if (destination===resolve(data,'cezeos.sqlite') || destination===key) throw new Error('Укажите отдельный файл для снимка.');
    await backup(db,destination);
    if (existsSync(key)) copyFileSync(key,destination+'.region-key.pem');
    console.log(destination);
  } else {
    if (process.env.CEZEOS_GOVERNANCE_HOME!=='1') throw new Error('Состав задаётся только на общем сервере управления.');
    const governance=createGovernance(db,process.env.CEZEOS_AQUAMARINE_ISSUER);
    db.exec('BEGIN IMMEDIATE');
    try {
      const seats=governance.setRoster(args);
      db.exec('COMMIT');
      console.log(seats.map(seat=>'@'+seat.nickname).join(', '));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
} finally { db.close(); }
