import { createI18n } from 'vue-i18n';

const messages = Object.fromEntries(
  Object.entries(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    import.meta.glob<{ default: any }>('./locales/*.json', { eager: true })
  ).map(([key, value]) => {
    console.log('Loading locale:', key, value);
    return [key.slice(10, -5), value.default];
  })
);

console.log('I18n Messages:', Object.keys(messages));

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: localStorage.getItem('lang') || 'en',
  fallbackLocale: 'en',
  messages,
});

console.log('I18n Instance:', i18n);
console.log('I18n Global:', i18n.global);

export default i18n;
