'use strict';
/** Focused R8 Admin render/command seams on the maintained owned fixture. */
const {defineConfig}=require('@playwright/test'),path=require('node:path');
const artifacts=process.env.PCM_ADMIN_ARTIFACTS||'/artifacts';
module.exports=defineConfig({testDir:'./tests',testMatch:['ui-review-admin.spec.js','admin-shell.spec.js','admin-source-trust.spec.js','admin-certificates.spec.js','admin-qualification.spec.js'],workers:1,retries:0,timeout:90000,expect:{timeout:5000},reporter:[['line'],['json',{outputFile:path.join(artifacts,'results.json')}]],outputDir:path.join(artifacts,'test-results'),use:{browserName:'chromium',actionTimeout:10000,screenshot:'only-on-failure'},projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]});
