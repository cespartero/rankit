#!/usr/bin/env node
// Updates public/version.json to "<date>-<n>": the date of this push (Adelaide time)
// and how many pushes to main there have been that day. Run by .github/workflows/version.yml.
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'version.json');
const tz = process.env.VERSION_TZ || 'Australia/Adelaide';
// en-CA formats dates as YYYY-MM-DD
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let cur = {};
try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
const n = cur.date === today ? (Number(cur.n) || 0) + 1 : 1;
const version = `${today.replace(/-/g, '.')}-${n}`;

fs.writeFileSync(file, JSON.stringify({ version, date: today, n }) + '\n');
console.log(version);
