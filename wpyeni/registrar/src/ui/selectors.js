const WA_PACKAGE = process.env.WA_PACKAGE || 'com.whatsapp';

const stateSelectors = {
  launch: {
    textAny: ['whatsapp', 'from meta'],
    idAny: [`${WA_PACKAGE}:id/splash_layout`],
  },
  customRomAlert: {
    textAny: ['custom rom', 'unsupported', 'resmi olmayan', 'not official'],
    idAny: ['android:id/alertTitle'],
    actionTextAny: ['ok', 'tamam'],
  },
  welcome: {
    textAny: ['agree and continue', 'welcome to whatsapp', 'kabul et ve devam et'],
    idAny: [`${WA_PACKAGE}:id/eula_accept`],
    actionTextAny: ['agree and continue', 'kabul et ve devam et'],
  },
  phoneInput: {
    textAny: ['enter your phone number', 'phone number', 'telefon numarası'],
    idAny: [
      `${WA_PACKAGE}:id/registration_phone`,
      `${WA_PACKAGE}:id/registration_country`,
      `${WA_PACKAGE}:id/registration_submit`,
    ],
  },
  notificationPrompt: {
    textAny: [
      'allow whatsapp to send notifications',
      'allow notifications',
      'would you like whatsapp to send notifications',
      'whatsapp bildirim göndersin mi',
      'bildirimlere izin ver',
    ],
    idAny: ['com.android.permissioncontroller:id/permission_message'],
    allowTextAny: ['allow', 'izin ver', 'ok'],
    denyTextAny: ['don\'t allow', 'allow only while using the app', 'izin verme', 'şimdi değil', 'not now'],
  },
  otpVerify: {
    textAny: ['enter code', 'verification code', 'verification', 'sms', 'kod', 'we sent an sms'],
    idAny: [
      `${WA_PACKAGE}:id/verify_sms_code_input`,
      `${WA_PACKAGE}:id/registration_code`,
      `${WA_PACKAGE}:id/code_input_and_progress_bar`,
    ],
  },
  home: {
    textAny: ['chats', 'durum', 'status', 'updates', 'calls', 'arama'],
    idAny: [
      `${WA_PACKAGE}:id/home_tab_layout`,
      `${WA_PACKAGE}:id/bottom_navigation_container`,
      `${WA_PACKAGE}:id/fab`,
    ],
  },
  blocked: {
    qrOrLinkingTextAny: ['link a device', 'scan qr', 'bağlı cihaz', 'qr kod'],
    overflowTextAny: ['more options', 'diğer seçenekler'],
  },
};

module.exports = {
  WA_PACKAGE,
  stateSelectors,
};
