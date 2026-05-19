const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const entryTimeStr = dayjs().tz('Asia/Kolkata').format();
console.log("Entry Time Str:", entryTimeStr);

const entryTime = dayjs(entryTimeStr);
const now = dayjs();
const minutesElapsed = now.diff(entryTime, 'minute');

console.log("Parsed Entry Time:", entryTime.format());
console.log("Now:", now.format());
console.log("Minutes elapsed:", minutesElapsed);
