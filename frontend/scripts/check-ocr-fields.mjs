import assert from 'node:assert/strict';
import {extractOcrFields, applyOcrFields} from '../src/ocrFields.js';

const apple = {template:'apple', availableFields:['fullName','birthday','country','language','email','phone','loginPhones','verification'], fieldLabels:{birthday:'出生日期',email:'其他电子邮件地址'}};
const line = (text, x=100, y=100, width=180, confidence=94) => ({text, confidence, bbox:{x0:x,y0:y,x1:x+width,y1:y+20}});
const byKey = values => Object.fromEntries(values.map(value => [value.key,value.value]));
const grid = [
  line('sidebar@example.invalid', 10, 60),
  line('姓名', 400, 100, 45), line('出生日期', 720, 100, 90),
  line('Synthetic Person', 400, 140), line('2000年2月29日', 720, 140),
  line('国家或地区', 400, 300, 100), line('语言', 720, 300, 45),
  line('中国台湾', 400, 340), line('繁體中文 - 中文 (繁體)', 720, 340, 220),
];
const original = JSON.stringify(grid);
assert.deepEqual(byKey(extractOcrFields(grid, apple)), {identifier:'sidebar@example.invalid', fullName:'Synthetic Person', birthday:'2000-02-29', country:'中国台湾', language:'繁體中文 - 中文 (繁體)'});
assert.equal(JSON.stringify(grid), original);
assert.ok(extractOcrFields(grid, apple).find(row => row.key === 'identifier').confidence <= 50);

const primary = [line('side@example.invalid', 10, 10), line('owner@example.invalid', 130, 200), line('主要电子邮件地址', 620, 200), line('其他电子邮件地址', 130, 300), line('other@example.invalid', 130, 340)];
assert.deepEqual(byKey(extractOcrFields(primary, apple)), {identifier:'owner@example.invalid', email:'other@example.invalid'});
assert.equal(extractOcrFields([line('a@example.invalid',10,10),line('b@example.invalid',10,80)],apple).length, 0);
assert.equal(byKey(extractOcrFields([line('owner@example.invalid'),line('owner@example.invalid',300,100)],apple)).identifier, 'owner@example.invalid');

const inline = ['姓名：测试账户', '出生日期: 19940601', 'Country or region: United States', 'Language: English (United States)', '其他電子郵件地址：other@example.invalid', '受信任電話號碼：+1 (202) 555-0100', '登入電話號碼：+86 13800138000', '雙重認證：已啟用'].map((text,index)=>line(text,100,index*100,500));
assert.deepEqual(byKey(extractOcrFields(inline,apple)), {fullName:'测试账户',birthday:'1994-06-01',country:'United States',language:'English (United States)',email:'other@example.invalid',phone:'+1 (202) 555-0100',loginPhones:'+86 13800138000',verification:'twofactor'});
assert.equal(extractOcrFields([line('双重认证：已开启')],{...apple,template:'google'}).length,0);
assert.equal(extractOcrFields([line('双重认证')],apple).length,0);
assert.equal(byKey(extractOcrFields([line('Two-factor authentication: Off')],apple)).verification,'disabled');
assert.equal(byKey(extractOcrFields([line('1 个受信任电话号码'),line('+1 202 555 0100',100,140)],apple)).phone,'+1 202 555 0100');
assert.equal(byKey(extractOcrFields([line('2 trusted phone numbers'),line('+1 202 555 0100',100,140),line('+1 202 555 0199',100,180)],apple)).phone,'+1 202 555 0100\n+1 202 555 0199');

for (const text of ['主要邮箱：o***@example.invalid','其他邮箱：••••@example.invalid','受信任电话号码：138****0000','受信任电话号码：138xxxx0000','生日：199406','生日：1994-02-29','生日：2000-13-01','姓名：查看详细信息','姓名：添加姓名','语言：未设置','姓名：Password','姓名：Apple 账户','密码：password@example.invalid','恢复密钥：ABCD-SECRET','付款方式：123456789','配送地址：Synthetic Street']) {
  assert.equal(extractOcrFields([line(text)],apple).length,0,text);
}
assert.equal(extractOcrFields([line('姓名',100,100),line('密码',100,130),line('Secret Name',100,160)],apple).length,0,'Unsupported labels must block lookahead');
assert.equal(extractOcrFields([line('姓名',100,100),line('密码：secret@example.invalid',100,130)],apple).length,0);
assert.equal(extractOcrFields([line('姓名：Wrong Person')],{template:'custom',availableFields:[]}).length,0);
assert.deepEqual(byKey(extractOcrFields([{text:'出生日期'},{text:'2000/2/29'}],apple)),{birthday:'2000-02-29'});
assert.equal(extractOcrFields([line('姓名：One Person'),line('姓名：Other Person',100,200)],apple).length,0,'Conflicting values must not be guessed');
assert.equal(byKey(extractOcrFields([line('出 生 日 期'),line('2000 年 2 月 29 日',100,140)],apple)).birthday,'2000-02-29');

const form = {identifier:'existing@example.invalid',birthday:'1990-01-01',phone:'1234567890',secrets:{password:'synthetic-private'},customFields:[{name:'extra',value:'keep',secret:true}],notes:'retain',verification:'none'};
const before = JSON.stringify(form);
const confirmed = applyOcrFields(form,[{key:'birthday',value:'20000229'},{key:'phone',value:'+1 202 555 0100'}]);
assert.equal(confirmed.birthday,'2000-02-29');
assert.equal(confirmed.phone,'+1 202 555 0100');
assert.equal(confirmed.identifier,form.identifier);
assert.equal(confirmed.secrets,form.secrets);
assert.equal(confirmed.customFields,form.customFields);
assert.equal(JSON.stringify(form),before);
assert.deepEqual(applyOcrFields(form,[]),form);
assert.deepEqual(applyOcrFields(form,[{key:'birthday',value:'20000229',selected:false},{key:'phone',value:'+1 202 555 0100',confirmed:false}]),form);
assert.deepEqual(applyOcrFields(form,[{key:'secrets',value:'overwrite'},{key:'password',value:'overwrite'},{key:'__proto__',value:'pollute'},{key:'birthday',value:'1900-02-29'},{key:'phone',value:'123***'},{key:'notes',value:'overwrite'},{key:'verification',value:'totp'}]),form);
assert.deepEqual(extractOcrFields(null,apple),[]);
assert.deepEqual(applyOcrFields(form,null),form);
console.log('OCR field checks passed: card layout, labels, masked data, dates, ambiguity, platform scope and confirmed-only merge.');
