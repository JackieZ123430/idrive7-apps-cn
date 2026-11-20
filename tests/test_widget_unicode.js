'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const families=["cauliflowermossgrape--idrive7-apps"];
function load(file,requireFn){const context={module:{exports:{}},require:requireFn,Promise,Map,Set};vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});return context.module.exports;}
async function test(folder,language){
    const runtime=path.join(root,'kit/runtime');
    const words=JSON.parse(fs.readFileSync(path.join(runtime,'locales/zh-CN.json'),'utf8'));
    const i18n=load(path.join(runtime,'i18n.js'),name=>{assert.equal(name,'./locale.json');return {language,strings:language==='en'?{}:Object.assign({Home:'首页'},words)};});
    const hmi=load(path.join(runtime,'hmi-text.js'),name=>{assert.equal(name,'./i18n');return i18n;});
    const code=fs.readFileSync(path.join(runtime,'mgu.js'),'utf8').match(/class Widget \{[\s\S]*?^\}/m)[0];
    const context={HmiText:hmi.HmiText,Promise,log:{warn:s=>{throw Error(s);}}};
    vm.runInNewContext(code+';this.Widget=Widget;',context);
    const widget=new context.Widget({});let resources={},calls=[];
    widget.comp={getStringBundle:()=>({setStrings:obj=>{Object.assign(resources,obj);return Promise.resolve();}}),setValue:(...args)=>{calls.push(args);return Promise.resolve();}};
    await widget.set(1,'Title','Settings','Text');
    if(language==='en')assert.deepEqual(calls.pop(),[1,'Title','Settings','Text']);
    else{const c=calls.pop();assert.equal(c[3],'StringId');assert.equal(resources[c[2]],'设置');}
    await widget.set(2,'Title','我的歌','Text',true);
    const chinese=calls.pop();assert.equal(chinese[3],'StringId');assert.equal(resources[chinese[2]],'我的歌');
    await widget.set(2,'Title','Home','Text',true);assert.deepEqual(calls.pop(),[2,'Title','Home','Text']);
    await widget.set(2,'Progress',0.7,'Float');assert.deepEqual(calls.pop(),[2,'Progress',0.7,'Float']);
    await widget.set(3,'Title','我的歌二','Text',true);
    assert.notEqual(calls[calls.length-1][2],chinese[2]);
    if(folder==='arefahmad--idrive7-apps'){
        const hw=load(path.join(runtime,'homewidget.js'),name=>name==='./i18n'?i18n:{Canvas:function(){},withAlpha:()=>''});
        const data={label:'Now playing',value:'Home',sub:'我的歌手',small:['Home','我的歌手'],literal:['value','sub','sub2','small']};
        const result=hw.localized(data);
        assert.equal(result.label,language==='en'?'Now playing':i18n.t('Now playing'));
        assert.equal(result.value,'Home');assert.equal(result.sub,'我的歌手');assert.equal(result.small[0],'Home');
        assert.equal(data.label,'Now playing','source metadata not mutated');
        const state=hw.localized({label:'Car Care',value:'Set up',small:['Car Care','Record your last services']});
        assert.equal(state.label,language==='en'?'Car Care':'车辆养护');
        assert.equal(state.small[0],state.label);
    }
}
(async()=>{for(const family of families)for(const language of ['en','zh-CN'])await test(family,language);console.log('PASS widget runtime x 2 languages: Unicode handles, independent spawns, literal music metadata, numeric values, big/small translation');})().catch(error=>{console.error(error);process.exitCode=1;});
