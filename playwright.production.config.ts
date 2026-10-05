import { defineConfig,devices } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e-production',fullyParallel:false,workers:1,
  use:{baseURL:'http://localhost:1422',...devices['Desktop Chrome'],storageState:{cookies:[],origins:[{origin:'http://localhost:1422',localStorage:[{name:'cn_set_onboarded',value:'1'}]}]}},
  webServer:{command:'npm run preview -- --port 1422 --strictPort',url:'http://localhost:1422',reuseExistingServer:false},
});
