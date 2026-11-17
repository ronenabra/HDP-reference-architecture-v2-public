'use strict';
/** Maintained pinned browser selection for the new native source, reusing the central viewer. */
const path=require('node:path');
const {defineConfig,devices}=require('@playwright/test');
const artifacts=path.resolve(process.env.PCM_LOGS_ARTIFACTS || '../../tmp/hapi-observability');
module.exports=defineConfig({testDir:'./tests',testMatch:'hapi-observability.spec.js',workers:1,retries:0,timeout:60000,
 reporter:[['line'],['json',{outputFile:path.join(artifacts,'results.json')}]],outputDir:path.join(artifacts,'test-results'),
 use:{baseURL:'http://127.0.0.1:43186',trace:'retain-on-failure',screenshot:'only-on-failure'},
 webServer:{command:JSON.stringify(process.execPath)+' hapi-observability-fixture-server.js',cwd:process.env.PCM_NAV_REPO?path.join(process.env.PCM_NAV_REPO,'pcm-connectathon/ui'):__dirname,url:'http://127.0.0.1:43186/logs-view',timeout:60000,reuseExistingServer:false,gracefulShutdown:{signal:'SIGTERM',timeout:5000}},
 projects:[{name:'chromium-desktop',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:900}}},{name:'chromium-mobile',use:{...devices['Pixel 7'],viewport:{width:390,height:844}}}]});
