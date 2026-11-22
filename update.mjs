import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const project=process.argv[2] || process.env.COMPOSE_PROJECT_NAME || 'cezeos';
if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error('Некорректное имя проекта Compose.');
const envFile=resolve(root,process.env.CEZEOS_ENV_FILE || '.env');
const compose=['compose','-f',join(root,'compose.yaml'),'-p',project,...(existsSync(envFile)?['--env-file',envFile]:[])];
const lock=join(root,'.cezeos-update-'+project+'.lock');

function docker(args, env=process.env, inherit=false) {
  const result=spawnSync('docker',args,{
    cwd:root, env, encoding:'utf8', stdio:inherit?'inherit':['ignore','pipe','inherit'], windowsHide:true
  });
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error('Не выполнено: docker '+args.slice(0,3).join(' '));
  return result.stdout?.trim() || '';
}

function composeRun(args, image, inherit=false) {
  const env=image?{...process.env,CEZEOS_IMAGE:image}:process.env;
  return docker([...compose,...args],env,inherit);
}

function start(image) {
  composeRun(['up','-d','--no-build','--pull','never','--wait','--wait-timeout','80','region'],image,true);
}

const lockFile=openSync(lock,'wx',0o600);
try {
  const image=composeRun(['config','--images','region']).split(/\r?\n/)[0];
  if(!image || image==='cezeos-region:dev' || !image.split('/')[0].includes('.')) {
    throw new Error('Укажите образ релиза из доверенного реестра в CEZEOS_IMAGE.');
  }
  const id=composeRun(['ps','-a','-q','region']);
  const previous=id?docker(['inspect','--format','{{.Image}}',id]):null;
  const timestamp=new Date().toISOString().replaceAll(/[^0-9]/g,'').slice(0,14);
  const rollback='cezeos-rollback:'+project+'-'+timestamp;
  if(previous) docker(['image','tag',previous,rollback]);
  docker(['pull',image],process.env,true);
  const candidate=docker(['image','inspect','--format','{{.Id}}',image]);
  const healthy=id && docker(['inspect','--format','{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',id])==='healthy';
  if(previous===candidate && healthy) {
    console.log('Регион уже использует текущий образ.');
  } else {
    if(previous) {
      composeRun(['exec','-T','region','node','operator.mjs','backup','/data/backups/before-'+timestamp+'.sqlite'],null,true);
    }
    try {
      start(image);
      console.log('Регион обновлён, проверка состояния пройдена.');
    } catch (error) {
      if(previous) {
        start(rollback);
        console.error('Предыдущий образ восстановлен. Снимок SQLite находится в томе.');
      }
      throw error;
    }
  }
} finally {
  closeSync(lockFile);
  unlinkSync(lock);
}
