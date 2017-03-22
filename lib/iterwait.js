'use strict';

// Timeout management
var stopped = false;
var timeouts = new Set();

function shutdown () {
	stopped = true;
	timeouts.forEach(function(t) {
		clearTimeout(t);
	});
}

// Custom error type for iteration shutdown
function StopIterationError (message) {
	this.name = 'StopIterationError';
	this.message = message || 'Iteration stopped';
}
StopIterationError.prototype = Object.create(Error.prototype);
StopIterationError.prototype.constructor = StopIterationError;

// Timeout promise with extra timeout management
function delay (time, val) {
	return new Promise(function (resolve, reject) {
		var timeout = setTimeout(delayed, time);
		timeouts.add(timeout);

		function delayed () {
			// Cleanup now-expired timeout
			if (timeout) {
				timeouts.delete(timeout);
			}
			// Resolve promise
			resolve(val);
		}
	});
}

// Timeout setter with extra timeout management
function delayloop (callback, time, value) {
	var timeout = setTimeout(delayed, time);
	timeouts.add(timeout);

	function delayed () {
		// Cleanup now-expired timeout
		if (timeout) {
			timeouts.delete(timeout);
		}
		// Call function
		callback(value);
	}
}

// For environments without setImmediate
// TODO: something with postMessage or MutationObserver?
var nextloop = (typeof setImmediate === 'function')
	? function (callback, time, value)  {
		return setImmediate(callback, value);
	}
	: function (callback, time, value) {
		return setTimeout(callback, 0, value);
	};

// Thenable checker
function isthenable (obj) {
	return obj !== undefined &&
		obj !== null &&
		typeof obj === 'object' &&
		'then' in obj;
}

// The main event (loop) ((ha))
function iterwait (iterable, func, time, inittime) {

	if (stopped) {
		return Promise.reject(new StopIterationError());
	}

	// Callable sanity check
	if (func !== undefined && func !== null && typeof func !== 'function') {
		// Shift parameters if only time(s) given
		if (typeof func === 'number') {
			time = func;
			inittime = time;
			func = undefined;
		}
		else {
			throw new Error(`Invalid function argument`);
		}
	}

	if (isthenable(iterable)) {
		return iterable.then(function (result) {
			return iterwait(result, func, time);
		});
	}

	var skip = false;
	var iter = iterable[Symbol.iterator]();
	var last = {value: undefined, done: false};
	var canthrow = ('throw' in iter);
	var didthrow = false;
	var iterloop = false;
	var res, rej;

	// Determine loop type
	if (time > 0) {
		iterloop = delayloop;
	}
	else if (time === 0) {
		iterloop = nextloop;
	}

	return new Promise(function (resolve, reject) {
		res = resolve;
		rej = reject;

		// Schedule stepper function
		if (inittime > 0) {
			delayloop(iterstep, inittime);
		}
		else if (time >= 0) {
			// Iteration job requested to be delayed per-iteration,
			// so start on next event loop
			nextloop(iterstep);
		}
		else {
			// Begin actually-immediately
			iterstep();
		}
	});

	// Actual iterator stepper
	function iterstep (result) {
		var val;

		if (stopped) {
			return rej(new StopIterationError());
		}

		last.value = result;

		while (!last.done) {
			try {
				val = last.value;

				// Advance loop if not in progress
				if (!skip) {
					// Check if we're coming from the catch handler
					if (canthrow && didthrow) {
						didthrow = false;
						last = iter.throw(val);
					}
					else {
						last = iter.next(val);
					}

					if (last.done) {
						break;
					}
					val = last.value;

					// Check for promise
					if (isthenable(val)) {
						// Set loop to resume (skipping next()) once promise resolved and break
						skip = true;
						// Tack on catch handler
						val.then(iterstep, iterthrow);
						return;
					}
				}
				// Officially in progress
				skip = false;

				// Call function if given
				if (func !== undefined && func !== null) {
					last.value = val = func(val);

					// Check for promise (again)
					if (isthenable(val)) {
						// Set loop to resume once promise resolved and break;
						// tack on catch handler
						val.then(iterstep, iterthrow);
						return;
					}
				}

				if (iterloop) {
					// Schedule next iterator step after specified delay or next event loop
					iterloop(iterstep, time, val);
					return;
				}
				// else continue loop and get next value
			}
			catch (e) {
				// Reject original promise
				return rej(e);
			}
		};

		if (last.done) {
			return res(last.value);
		}
	}

	function iterthrow (reason) {
		if (canthrow) {
			skip = false;
			didthrow = true;
			return iterstep(reason);
		}
		return rej(reason);
	}
}

// Make extra timeout/iteration management available
iterwait.delay = delay;
iterwait.timeouts = timeouts;
iterwait.shutdown = shutdown;
iterwait.StopIterationError = StopIterationError;

module.exports = iterwait;
