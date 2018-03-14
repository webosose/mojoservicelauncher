var domain = require('domain');

// Find first domain callback.
domain.findFirstCallback = function (dom) {
  return findFirstCallback (process._getActiveRequests(), dom) ||
         findFirstCallback (process._getActiveHandles() , dom) ;
};

// Find first domain callback in Requests or Handles array.
function findFirstCallback (arr, dom) {
  var cb = null, className;
  for (var i = 0; i < arr.length; i++) {
    className = arr[i].__proto__
             && arr[i].__proto__.constructor
             && arr[i].__proto__.constructor.name
              ? arr[i].__proto__.constructor.name
              : "Unknown";
    if (className === 'Timer') cb = findFirstTimer(arr[i], dom);
    if (cb) return cb;
  }
  return null;
}

// Find first domain timer callback in timers linked list.
function findFirstTimer (timer, domain) {
  var first = timer._idleNext;
  var t = first;
  do {
    if (t && t.domain && t.domain === domain) return t._onTimeout;
    t = t._idleNext;
  } while (t !== first);
  return null;
}

module.exports = domain;
