export const APPLE_SECTIONS = [
  {title: '付款与配送', fields: {paymentMethods: '付款方式备注', shippingAddress: '配送地址'}},
  {title: '订阅与家庭', fields: {subscriptions: '订阅备注', familySharing: '家人共享'}},
  {title: '设备', fields: {devices: '关联设备'}},
  {title: '隐私', fields: {hideMyEmail: '隐藏邮件地址', gender: '性别', icloudAnalytics: 'iCloud 分析', appleMessages: '来自 Apple 的信息'}},
];

export const VERIFICATION_OPTIONS = {none: '未记录', totp: '身份验证器 TOTP', device: '受信任设备', sms: '短信 / 电话', passkey: '安全密钥 / 通行密钥', multiple: '多种方式', twofactor: '已开启双重认证', disabled: '未开启双重认证'};

export function applicable(platform, key) {
  return ['identifier', 'title', 'group', 'tags', 'status'].includes(key) || !platform?.availableFields || platform.availableFields.includes(key);
}

export function fieldLabel(platform, key, fallback) {
  const label = platform?.fieldLabels?.[key] || fallback;
  return applicable(platform, key) ? label : `${label}（历史补充）`;
}

export function fieldEnabled(platform, form, key, allFields = false, retainedFields = []) {
  const value = Object.hasOwn(form.secrets || {}, key) ? form.secrets[key] : form[key];
  const populated = Boolean(value && !(key === 'loginMethod' && value === 'password') && !(key === 'verification' && value === 'none'));
  return retainedFields.includes(key) || (applicable(platform, key) && (allFields || Boolean(platform?.fields?.includes(key)))) || populated;
}

export function mergePlatformFields(existing = [], templates = []) {
  const fields = existing.map(field => {
    const template = templates.find(item => item.name.toLowerCase() === field.name.toLowerCase());
    return {...field, secret:field.secret || Boolean(template?.secret)};
  });
  for (const template of templates) {
    if (template.enabled && !fields.some(field => field.name.toLowerCase() === template.name.toLowerCase())) {
      fields.push({name:template.name, value:'', secret:template.secret});
    }
  }
  return fields;
}

export function verificationOptions(platform, value) {
  if (platform?.template !== 'apple') return VERIFICATION_OPTIONS;
  const options = {none: VERIFICATION_OPTIONS.none, twofactor: VERIFICATION_OPTIONS.twofactor, disabled: VERIFICATION_OPTIONS.disabled};
  // Preserve the existing classification until the user explicitly changes it.
  if (value && !(value in options)) options[value] = `${VERIFICATION_OPTIONS[value] || value}（历史记录）`;
  return options;
}
