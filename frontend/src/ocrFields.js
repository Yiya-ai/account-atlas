import {applicable, fieldLabel} from './accountFields.js';
import {normalizeDateInput} from './calendarDate.js';

// OCR only proposes these non-secret fields. It never produces passwords,
// recovery codes, payment details, custom fields or account status changes.
const FIELDS = {
  identifier: {label:'账号标识', aliases:['主要电子邮件地址', '主要電子郵件地址', '主要邮箱', '主要郵箱', 'Primary email address', 'Primary email', 'Apple ID', '账号标识', '帳號標識']},
  fullName: {label:'姓名', aliases:['姓名', 'Full name', 'Name']},
  birthday: {label:'生日', aliases:['出生年月日', '出生日期', '生日', 'Date of birth', 'Birth date', 'Birthday']},
  country: {label:'国家或地区', aliases:['国家或地区', '國家或地區', '国家/地区', '國家/地區', 'Country or region', 'Country/Region']},
  language: {label:'语言', aliases:['语言', '語言', 'Language']},
  email: {label:'联系邮箱', aliases:['其他电子邮件地址', '其他電子郵件地址', '其他邮箱', '其他郵箱', '联系邮箱', '聯繫郵箱', 'Additional email addresses', 'Additional email', 'Other email addresses', 'Other email', 'Contact email']},
  phone: {label:'绑定手机号 / 受信任电话', aliases:['受信任电话号码', '受信任電話號碼', '受信任电话', '受信任電話', '绑定手机号', '綁定手機號', 'Trusted phone numbers', 'Trusted phone number', 'Trusted phone', 'Phone number']},
  loginPhones: {label:'登录电话号码', aliases:['登录电话号码', '登入電話號碼', '登錄電話號碼', 'Login phone numbers', 'Login phone number']},
  verification: {label:'双重认证', aliases:['双重认证', '雙重認證', '雙重驗證', 'Two-factor authentication']},
};
const MULTIPLE = new Set(['email', 'phone', 'loginPhones']);
const MASKED = /[*•●…■█×⋯?]/u;
const EMAIL = /^[A-Z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/i;
const UNSUPPORTED_LABELS = ['密码', '密碼', '登录密码', '登入密碼', 'Password', 'App 专用密码', 'App 專用密碼', 'App-specific passwords', '恢复密钥', '恢復密鑰', 'Recovery key', '恢复码', '恢復碼', 'Recovery codes', '付款与配送', '付款與寄送', 'Payment and shipping', '付款方式', 'Payment method', '配送地址', 'Shipping address', '地址', 'Address', '性别', '性別', 'Gender', '安全密钥', '安全密鑰', 'Security keys', '电子邮件和电话号码', '電子郵件和電話號碼', 'Email and phone numbers', '登录与安全性', '登入與安全性', 'Sign-in and security', '个人信息', '個人資訊', 'Personal information', '账户安全', '帳戶安全', 'Account security'];
const compact = text => text.replace(/\s+/gu, '').toLowerCase();
const clean = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliases = Object.entries(FIELDS).flatMap(([key, field]) => field.aliases.map(alias => ({key, alias})))
  .sort((a, b) => b.alias.length - a.alias.length)
  .map(item => ({...item, pattern:new RegExp(`^${[...item.alias].map(escaped).join('\\s*')}${/[\u3400-\u9fff]/u.test(item.alias) ? '\\s*[:：]?\\s*' : '(?:\\s*[:：]\\s*|\\s+)'}(.+)$`, 'iu')}));

function identify(text) {
  // Apple renders the count as part of this section label, not the phone value.
  text = text.replace(/^\d+\s*(?:个|個)\s*(?=受信任)/u, '').replace(/^\d+\s+(?=trusted phone numbers?$)/iu, '');
  for (const item of aliases) {
    if (compact(text.replace(/[:：]$/, '')) === compact(item.alias)) return {key:item.key, value:''};
    const match = item.pattern.exec(text);
    if (match) return {key:item.key, value:match[1].trim()};
  }
  return null;
}

function isUnsupported(text) {
  const value = compact(text);
  return UNSUPPORTED_LABELS.some(label => value === compact(label) || value.startsWith(`${compact(label)}:`));
}

function normalizeValue(key, raw) {
  const value = clean(raw);
  if (!value || value.length > 1000 || MASKED.test(value)) return null;
  if (key === 'birthday') return normalizeDateInput(value.replace(/\s+/g, '')) || null;
  if (key === 'identifier') return EMAIL.test(value) ? value : normalizeValue('phone', value);
  if (key === 'email') {
    const items = raw.split(/[\n,;，；]+/u).map(clean).filter(Boolean);
    return items.length && items.every(item => !MASKED.test(item) && EMAIL.test(item)) ? [...new Set(items)].join('\n') : null;
  }
  if (key === 'phone' || key === 'loginPhones') {
    const items = raw.split(/[\n,;，；]+/u).map(clean).filter(Boolean);
    return items.length && items.every(item => /^\+?[\d ()-]+$/.test(item) && item.replace(/\D/g, '').length >= 7 && item.replace(/\D/g, '').length <= 15)
      ? [...new Set(items)].join('\n') : null;
  }
  if (key === 'verification') {
    if (['twofactor', '已开启', '已開啟', '已启用', '已啟用', '开启', '開啟', 'enabled', 'on'].includes(value.toLowerCase())) return 'twofactor';
    if (['disabled', '未开启', '未開啟', '未启用', '未啟用', '关闭', '關閉', 'off'].includes(value.toLowerCase())) return 'disabled';
    return null;
  }
  if (!Object.hasOwn(FIELDS, key) || identify(value) || isUnsupported(value)) return null;
  if (/^(?:添加|新增|管理|查看|编辑|編輯|更改|设置|設定|未设置|未設定|没有|沒有|以下|如果|点击|點擊|前往|了解|更多|你的|您的|请|請|add\b|manage\b|view\b|edit\b|learn\b|not set\b|none$)/iu.test(value)) return null;
  if (/^(?:Apple\s*(?:账户|帳戶|账号|Account)|登录|登入|退出登录|Sign in|Sign out)$/iu.test(value)) return null;
  if (key === 'fullName') return value.length <= 100 && /^[\p{L}\p{M}][\p{L}\p{M} .’'·-]*$/u.test(value) ? value : null;
  if (key === 'country' || key === 'language') return value.length <= 100 && /^[\p{L}\p{M}][\p{L}\p{M} ()/.’',-]*$/u.test(value) ? value : null;
  return null;
}

function box(value) {
  if (!value || !['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(value[key])) || value.x1 <= value.x0 || value.y1 <= value.y0) return null;
  return value;
}

function proximity(label, candidate, lines) {
  const a = label.bbox, b = candidate.bbox;
  if (!a || !b) return candidate.index === label.index + 1 ? 100 : null;
  const height = Math.max(a.y1 - a.y0, b.y1 - b.y0);
  const sameRow = Math.abs((a.y0 + a.y1 - b.y0 - b.y1) / 2) <= height * .6;
  const gap = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
  if (sameRow && gap <= Math.max(400, height * 16)) {
    const between = lines.some(other => other !== label && other !== candidate && (other.label || other.unsupported) && other.bbox
      && Math.abs((other.bbox.y0 + other.bbox.y1 - a.y0 - a.y1) / 2) <= height * .6
      && other.bbox.x0 > Math.min(a.x0, b.x0) && other.bbox.x1 < Math.max(a.x1, b.x1));
    if (!between) return gap;
  }
  const deltaY = b.y0 - a.y1;
  if (deltaY < -height * .2 || deltaY > Math.max(100, height * 5) || Math.abs(a.x0 - b.x0) > Math.max(36, height * 2)) return null;
  const blocked = lines.some(other => other !== label && other !== candidate && (other.label || other.unsupported) && other.bbox
    && other.bbox.y0 >= a.y1 && other.bbox.y0 < b.y0 && Math.abs(other.bbox.x0 - a.x0) <= Math.max(36, height * 2));
  return blocked ? null : 500 + deltaY + Math.abs(a.x0 - b.x0);
}

/** Produce suggestions only. The caller must preview and obtain confirmation. */
export function extractOcrFields(input, platform) {
  if (!Array.isArray(input)) return [];
  const lines = input.slice(0, 2000).map((line, index) => {
    const text = clean(line?.text).slice(0, 1000);
    return {index, text, bbox:box(line?.bbox), confidence:Number.isFinite(line?.confidence) ? Math.max(0, Math.min(100, line.confidence)) : 0,
      label:identify(text), unsupported:isUnsupported(text)};
  }).filter(line => line.text);
  const suggestions = [];
  const used = new Set();
  const add = (key, value, line, label, priority) => {
    if (!value || !applicable(platform, key) || (key === 'verification' && platform?.template !== 'apple')) return;
    suggestions.push({key, value, confidence:Math.min(line.confidence, label.confidence), source:line === label ? line.text : `${label.text}\n${line.text}`, priority});
    used.add(line.index);
  };
  for (const label of lines.filter(line => line.label)) {
    const {key, value} = label.label;
    if (value) {add(key, normalizeValue(key, value), label, label, 2); continue;}
    const candidates = lines.filter(line => line !== label && !line.label && !line.unsupported)
      .map(line => ({line, value:normalizeValue(key, line.text), distance:proximity(label, line, lines)}))
      .filter(item => item.value && item.distance !== null).sort((a, b) => a.distance - b.distance);
    if (candidates.length) {
      const nearest = candidates[0];
      add(key, nearest.value, nearest.line, label, 1);
      if (MULTIPLE.has(key)) {
        for (const candidate of candidates.slice(1)) {
          // Multiple contact rows must share the label's column, not another card.
          if (candidate.distance >= 500 && nearest.distance >= 500) add(key, candidate.value, candidate.line, label, 1);
        }
      }
    }
  }
  // A single unlabelled email may be offered for review, at low confidence.
  // Never choose arbitrarily among a sidebar address and a different account.
  if (!suggestions.some(item => item.key === 'identifier')) {
    const emails = lines.filter(line => !line.label && !line.unsupported && !used.has(line.index) && EMAIL.test(line.text) && !MASKED.test(line.text)
      && !lines.some(label => (label.label || label.unsupported) && proximity(label, line, lines) !== null));
    if (new Set(emails.map(line => line.text.toLowerCase())).size === 1) {
      const line = emails[0];
      suggestions.push({key:'identifier', value:line.text, confidence:Math.min(50, line.confidence), source:`未标注邮箱，请确认是否为登录账号：\n${line.text}`, priority:0});
    }
  }
  return Object.entries(FIELDS).flatMap(([key, field]) => {
    const found = suggestions.filter(item => item.key === key);
    if (!found.length) return [];
    const priority = Math.max(...found.map(item => item.priority));
    const best = found.filter(item => item.priority === priority);
    const values = [...new Set(best.flatMap(item => item.value.split('\n')))];
    if (values.length > 1 && !MULTIPLE.has(key)) return []; // Conflicting readings need manual review.
    return [{key, label:fieldLabel(platform, key, field.label), value:values.join('\n'), confidence:Math.min(...best.map(item => item.confidence)), source:[...new Set(best.map(item => item.source))].join('\n')}];
  });
}

/** Pass only rows selected in the confirmation preview. Existing fields stay intact. */
export function applyOcrFields(form, confirmedCandidates) {
  const result = {...form};
  if (!Array.isArray(confirmedCandidates)) return result;
  for (const candidate of confirmedCandidates) {
    if (!candidate || candidate.selected === false || candidate.confirmed === false || !Object.hasOwn(FIELDS, candidate.key) || typeof candidate.value !== 'string') continue;
    const value = normalizeValue(candidate.key, candidate.value);
    if (value) result[candidate.key] = value;
  }
  return result;
}
