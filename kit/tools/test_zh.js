'use strict';
// Translation by: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430.
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os');
const kit=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../runtime');
const i18n=require(path.join(kit,'i18n')),{t,getLanguage}=i18n;
const locale=JSON.parse(fs.readFileSync(path.join(kit,'locale.json'),'utf8'));
const language=locale.language||'en',chinese=language==='zh-CN',russian=language==='ru';
const {HmiText,slotId}=require(path.join(kit,'hmi-text'));
const {Canvas}=require(path.join(kit,'canvas'));
const {Recorder,atlasId}=require(path.join(kit,'record'));
const {CREDIT,drawCredit}=require(path.join(kit,'credits'));
const creditFile=path.resolve(__dirname,'../localization/credit.'+language+'.json');
const creditData=language!=='en'&&fs.existsSync(creditFile)?JSON.parse(fs.readFileSync(creditFile,'utf8')):null,credited=!!creditData;
const fonts=require(path.join(kit,'fonts'));
const {statusInfo,NRC}=require(path.join(kit,'diag'));
const {fitText}=require(path.join(kit,'text-layout'));
const expected={en:'Settings','zh-CN':'设置',ru:'Настройки'};
async function main(){
 assert(Object.prototype.hasOwnProperty.call(expected,language),'unsupported fixed language '+language);
 assert.strictEqual(getLanguage(),language);
 assert.strictEqual(t('Settings'),expected[language]);
 assert.strictEqual(t('rpm'),'rpm');assert.strictEqual(t('config.battery'),'config.battery');
 assert.strictEqual(i18n.setLanguage,undefined,'no runtime language switching');
 assert.strictEqual(locale.languages,undefined,'a fixed package must not advertise language choices');
 assert.deepStrictEqual(Object.keys(locale).sort(),credited?['credit','language','strings']:['language','strings']);
 assert.strictEqual(CREDIT,credited?creditData.corner:'');
 assert.strictEqual(locale.credit,credited?creditData.corner:undefined);
 const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mgu-language-')));
 try{
  fs.copyFileSync(path.join(kit,'i18n.js'),path.join(tmp,'i18n.js'));
  for(const fixedLanguage of ['en','zh-CN','ru','de-test']){
   const strings=fixedLanguage==='zh-CN'?{Settings:'设置'}:fixedLanguage==='ru'?{Settings:'Настройки'}:{Settings:'Einstellungen'};
   fs.writeFileSync(path.join(tmp,'locale.json'),JSON.stringify({language:fixedLanguage,strings}));
   delete require.cache[require.resolve(path.join(tmp,'i18n.js'))];delete require.cache[path.join(tmp,'locale.json')];
   const fixed=require(path.join(tmp,'i18n.js'));
   assert.strictEqual(fixed.getLanguage(),fixedLanguage);
   assert.strictEqual(fixed.setLanguage,undefined,'generic catalogs remain fixed-language');
   assert.strictEqual(fixed.t('Settings'),fixedLanguage==='en'?'Settings':strings.Settings);
  }
 }finally{fs.unlinkSync(path.join(tmp,'i18n.js'));fs.unlinkSync(path.join(tmp,'locale.json'));fs.rmdirSync(tmp)}
 const updates=[],writes=[],component={getStringBundle:()=>({setStrings:async x=>updates.push(x)}),setValue:async(...x)=>writes.push(x)};
 const hmi=new HmiText();await hmi.set(component,'BTN',0,'Text','Scan now');
 if(chinese||russian){
  assert.deepStrictEqual(updates[0],{[slotId(0)]:russian?'Сканировать':'立即扫描'});
  assert.strictEqual(writes[0][3],'StringId');
 }else assert.deepStrictEqual(writes[0],[0,'Text','Scan now','Text']);
 await hmi.set(component,'CODE',0,'Text','D1C604');assert.deepStrictEqual(writes[1],[0,'Text','D1C604','Text']);
 if(!chinese&&!russian)assert.strictEqual(updates.length,0,'English uses native ASCII HMI text');
 if(language!=='en'){
  const sample=russian?'Привет':'中文',f=fonts.get('bold',32,sample),catalog=JSON.parse(fs.readFileSync(path.join(kit,'locales',language+'.json'),'utf8'));
  const atlas=russian?'cyrillic':'cjk';
  assert.notStrictEqual(atlasId(f,atlas),atlasId(Object.assign({},f,{cacheKey:f.cacheKey+'-changed'}),atlas),'font updates must not reuse an old GPU texture');
  for(const ch of CREDIT+Object.values(catalog).join(''))assert(f.glyphs[ch.codePointAt(0)],'missing '+language+' glyph '+ch);
 }
 const cv=new Canvas(800,120),r=new Recorder(800,120),opts={font:'bold'};
 if(chinese){
  assert.strictEqual(t(t('eDrive')),t('eDrive'),'localized app titles must not be translated twice');
  assert.strictEqual(t('RANGE AT THIS RATE'),'按当前能耗估算续航');
  assert.strictEqual(t('Engine Config'),'发动机配置');
  assert.strictEqual(t('Transmission Config'),'变速箱配置');
  assert.strictEqual(t('Max Cooling ON'),'最大冷却 开启');
  assert.strictEqual(t('64 cells'),'64 个单元格','map cells are not battery cells');
  assert.strictEqual(t('up'),'升挡','translate stored shift groups only at display time');
  for(const bits of [0x01,0x80,0x04,0x08,0]){
   const label=statusInfo(bits).label;assert.notStrictEqual(t(label),label,'untranslated DTC status '+label);
  }
  for(const label of Object.values(NRC))assert.notStrictEqual(t(label),label,'untranslated diagnostic rejection '+label);
  const fitted=fitText(cv,'ZGM: Ethernet: Communication ended unexpectedly',22,190);
  assert(!fitted.includes('Ethernet')&&fitted.includes('以太网'),'translate the full diagnostic sentence before truncation');
  assert(cv.textWidth(fitted,22)<=190,'localized truncated text must fit');
  assert.strictEqual(t('FAULTS'),'故障');
  const G=require(path.join(kit,'gauges')),theme=require(path.join(kit,'themes')).theme('m_tricolour');
  const labels=[],mock={w:1600,fillRect:()=>{},gradientRect:()=>{},textWidth:()=>50,text:(s)=>labels.push(s)};
  G.frame(mock,theme,['History','Faults'],0,[]);
  assert(labels.includes('历史')&&labels.includes('故障'),'translate heading context before uppercasing');
 }
 if(russian){
  assert.strictEqual(t('Max Cooling ON'),'МАКСИМАЛЬНОЕ ОХЛАЖДЕНИЕ ВКЛ.');
  assert.strictEqual(t('64 cells'),'64 ячейки');assert.strictEqual(t('up'),'вверх');
  assert.strictEqual(t('Transmission Config'),'Настройка АКПП');
  assert.strictEqual(t('LIVE · UNVERIFIED'),'ОНЛАЙН · БЕЗ ПРОВЕРКИ');
  for(const bits of [0x01,0x80,0x04,0x08,0]){
   const label=statusInfo(bits).label;assert.notStrictEqual(t(label),label,'untranslated Russian DTC status '+label);
  }
  for(const label of Object.values(NRC))assert.notStrictEqual(t(label),label,'untranslated Russian diagnostic rejection '+label);
  const G=require(path.join(kit,'gauges')),theme=require(path.join(kit,'themes')).theme('m_tricolour');
  const demo={text:'DEMO'},sim={text:'SIM',color:'warn'},knob={text:'KNOB',color:'accent'},rollout={text:'ROLLOUT 1 FT',color:'dim'};
  const cases=[
   ['brake_test','Brake Test',['Brake test','History','Settings'],[demo]],
   ['car_vitals','M Vitals',['Engine','Thermals','Fuel & ignition','Chassis','Settings'],[demo]],
   ['draggy','Drag Timer',['Drag timer','Best times','Settings'],[demo,rollout]],
   ['dtc_scanner','Fault Scanner',['Faults  1/2','Check Control','Control units','Settings'],[demo]],
   ['dyno','Virtual Dyno',['Virtual dyno','Saved runs','Settings'],[demo]],
   ['edrive hybrid','eDrive',['Range','Energy','Battery','Charge log','Diagnostic','Settings'],[demo]],
   ['edrive 12 V','eDrive',['12 V battery','History','Diagnostic','Settings'],[demo]],
   ['gforce','G-Force',['G-force','Records','Settings'],[demo]],
   ['live_adjustments BM3+xDrive','Engine Config',['Exhaust Flap','Engine Map','Burbles','Active Sound','xDrive','Settings'],[sim]],
   ['live_adjustments MHD','Engine Config',['Exhaust Flap','Engine Map','Max Cooling','Settings'],[sim]],
   ['live_data','Live Data',['New screen','Trips','Signals 1/2','Engine 1/2','Units','Settings'],[demo,knob]],
   ['live_data gauges','Live Data',['Gauges 1/3','Trips','Signals','Engine','Units','Settings'],[demo]],
   ['redline','Redline',['Tach','Shift log','Settings'],[demo]],
   ['service','Service',['Service','Diagnostics','Settings'],[demo]],
   ['warmup','Warm-Up',['Warm-up','Settings'],[demo]],
   ['zf8hp','Transmission Config',['Live','Clutches','Shifts','Map','Thermal','Details','Reference','Settings'],[{text:'EXPERIMENTAL',color:'warn'},{text:'LIVE · UNVERIFIED',color:'warn'}]],
  ];
  const checkTabs=(name,title,tabs,badges)=>{
   const header=new Canvas(1920,720);G.header(header,theme,84,0,1256,80,title,tabs,0,badges,true,true);
   const rects=header.tabRects||[];
   assert.deepStrictEqual(rects.map(x=>x.i),tabs.map((x,i)=>i),name+': every tab must fit the Russian header');
   assert(rects.some(x=>x.i===tabs.length-1),name+': SETTINGS must remain reachable');
  };
  for(const args of cases)checkTabs(...args);
  for(const state of ['DEMO','NO LINK','IDENTIFYING','OTHER EGS','LINK STALE','LIVE','LIVE · UNVERIFIED'])
   checkTabs('zf8hp '+state,'Transmission Config',cases.find(c=>c[0]==='zf8hp')[2],[{text:'EXPERIMENTAL',color:'warn'},{text:state,color:'warn'}]);
 }
 assert.strictEqual(cv.text('Oil',10,50,32,'#ffffff',opts),r.text('Oil',10,50,32,'#ffffff',opts));
 assert.strictEqual(cv.textWidth('Oil',32,opts),r.textWidth('Oil',32,opts));
 const credit=new Canvas(600,40);drawCredit(credit,580,25);let alpha=0;
 for(let i=3;i<credit.d.length;i+=4)alpha=Math.max(alpha,credit.d[i]);
 assert(credited?alpha>0&&alpha<=64:alpha===0,'credit visibility follows the installed language');
 let height=0;for(const name of fs.readdirSync(path.join(kit,'fonts')).filter(x=>x.endsWith('.json'))){
  const file=JSON.parse(fs.readFileSync(path.join(kit,'fonts',name),'utf8'));for(const s of file.sizes){assert(s.atlasW<=1024&&s.atlasH<=4096);height+=s.atlasH+1}
 }assert(height<8192,'GPU atlas budget');
 console.log('PASS: fixed '+language+' package, no runtime switching, native strings, glyphs, renderer metrics and translation credit only where the language has one');
}
main().catch(e=>{console.error(e);process.exit(1)});
