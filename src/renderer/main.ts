import Vue from 'vue';
import ElectronStore from 'electron-store';
import { escape } from 'querystring';
import minimist from 'minimist';
import { ipcRenderer } from 'electron';
import './assets/scss/main.scss';
import { StoreConstants } from '@/utils/constants';
import App from './App.vue';
import router from './router';
import { hexOpacityMapping } from './helper/hexOpacityMapping';

const electronStore = new ElectronStore();

ipcRenderer.on('settings', async () => {
  await router.push({ path: '/settings' });
});

ipcRenderer.on('index', async () => {
  await router.push('/index');
});

ipcRenderer.on('chat', async () => {
  await router.push('/chat');
});

Vue.config.productionTip = false;

// config globals

Vue.prototype.$config = electronStore;
Vue.prototype.$windowBackgroundColor = `#${String(
  electronStore.get(StoreConstants.BackgroundColor, '5c279d'),
)}${hexOpacityMapping[String(electronStore.get(StoreConstants.OpacityLevel, '1'))]}`;
Vue.prototype.$showBorder = electronStore.get(StoreConstants.ShowBorders, true);
Vue.prototype.$fontSize = electronStore.get(StoreConstants.FontSize, undefined);
Vue.prototype.$chatColor = electronStore.get(StoreConstants.ChatColor, '#fff');
Vue.prototype.$isSettingsPage = electronStore.get(StoreConstants.IsSettingsPage, false);
Vue.prototype.$fontStroke = electronStore.get(StoreConstants.FontStroke, false);
Vue.prototype.$strokeColor = electronStore.get(StoreConstants.StrokeColor, '#000');

const vue = new Vue({
  ...App,
  router,
}).$mount('#app');

const args = minimist(process.argv);
const parameters = {
  chatlog: '',
  socketName: '',
};

if ('chatlog' in args) {
  parameters.chatlog = escape(args.chatlog);
}
if ('pipename' in args) {
  parameters.socketName = escape(args.pipename);
}
vue.$router.replace({
  name: 'chat',
  params: parameters,
});
