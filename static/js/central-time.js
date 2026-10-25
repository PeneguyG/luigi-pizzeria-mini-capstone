/* Restaurant wall-clock values always use Central Time, regardless of device. */
'use strict';
window.LuigiTime = Object.freeze({
  zone: 'America/Chicago',
  parts(date) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((parts, part) => {
      if (part.type !== 'literal') parts[part.type] = part.value;
      return parts;
    }, {});
  },
  dateValue(date) {
    const p = this.parts(date);
    return p.year + '-' + p.month + '-' + p.day;
  },
  timeValue(date) {
    const p = this.parts(date);
    return p.hour + ':' + p.minute;
  }
});
