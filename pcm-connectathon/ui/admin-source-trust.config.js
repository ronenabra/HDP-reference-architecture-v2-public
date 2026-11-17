'use strict';
/** Focused source24 browser proof uses the existing supplied representative Chromium runtime. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir:'./tests',testMatch:'admin-source-trust.spec.js',workers:1,retries:0,timeout:60000,
    expect:{timeout:5000},reporter:[['line'],['json',{outputFile:'/artifacts/results.json'}]],outputDir:'/artifacts/test-results',
    use:{browserName:'chromium',hasTouch:true,viewport:{width:1440,height:1000},screenshot:'only-on-failure'} });
