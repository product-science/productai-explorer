import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import Pages from 'vite-plugin-pages';
import Layouts from 'vite-plugin-vue-layouts';
import AutoImport from 'unplugin-auto-import/vite';
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite';
import DefineOptions from 'unplugin-vue-define-options/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
    base: '/dashboard',
    define: {
        global: 'window',
        'process.env': {},
    },
    plugins: [
        nodePolyfills({
            globals: {
                Buffer: true,
            },
            modules: {
                buffer: true,
            },
        }),
        vue({
            template: {
                compilerOptions: {
                    isCustomElement: (tag) =>
                        [
                            'ping-connect-wallet',
                            'ping-token-convert',
                            'ping-tx-dialog',
                        ].includes(tag),
                },
            },
        }),
        vueJsx(),
        Pages({
            dirs: ['./src/modules', './src/pages'],
            exclude: ['**/*.ts'],
        }),
        Layouts({
            layoutsDirs: './src/layouts/',
        }),
        AutoImport({
            imports: [
                'vue',
                'vue-router',
                '@vueuse/core',
                '@vueuse/math',
                'vue-i18n',
                'pinia',
            ],
            vueTemplate: true,
        }),
        VueI18nPlugin({
            runtimeOnly: true,
            compositionOnly: true,
            include: [
                fileURLToPath(
                    new URL('./src/plugins/i18n/locales/**', import.meta.url)
                ),
            ],
        }),
        DefineOptions(),
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            buffer: 'buffer',
        },
    },
    optimizeDeps: {
        include: ['buffer'],
        entries: ['./src/**/*.vue'],
    },
    server: {
        host: '0.0.0.0',
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/rpc': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
});
