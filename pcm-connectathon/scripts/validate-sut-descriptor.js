#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, readJson } = require('./lib');
const { validateDescriptor } = require('./export-sut-descriptor');

const args = parseArgs(process.argv);
if (!args.input) throw new TypeError('--input is required');
validateDescriptor(readJson(path.resolve(args.input)), { releaseGrade: Boolean(args['release-grade']) });
console.log(JSON.stringify({ status: 'pass', schemaVersion: '3.0' }));
