'use strict';

var timeouts = new Set();

function isthenable (obj) {
	return obj !== undefined && obj !== null && typeof obj === 'object' && 'then' in obj;
}

function delayloop (callback, time) {
	var timeout = setTimeout(delayed, time);

	function delayed () {
		// Cleanup now-expired timeout
		if (timeout) {
			timeouts.delete(timeout);
		}
		// Call function
		callback();
	}
}

// TODO: more browser-specific checks?
var nextloop = (typeof setImmediate === 'function')
	? setImmediate 
	: function (callback) {
		return setTimeout(callback, 0);
	};

function iterwait (iterable, func, time, inittime) {
	// Callable sanity check
	if (func !== undefined && typeof func !== 'function') {
		throw new Error(`Paramter 'func' must be a function or undefined`);
	}

	if (isthenable(iterable)) {
		return iterable.then(function (result) {
			return iterwait(result, func, time);
		});
	}

	var iter = iterable[Symbol.iterator]();
	var last = {value: undefined, done: false};
	var skip = false;
	var res, rej;

	return new Promise(function (resolve, reject) {
		res = resolve;
		rej = reject;

		// Schedule stepper function
		if (inittime > 0) {
			delayloop(iterstep, inittime);
		}
		else if (time >= 0) {
			// Iteration job requested to be delayed per-iteration, so start on next event loop
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

		if (result !== undefined) {
			last = {value: result, done: last.done};
		}

		while (!last.done) {
			try {
				val = last.value;

				// Advance loop if not in progress
				if (!skip) {
					last = iter.next(val);
					if (last.done) {
						break;
					}
					val = last.value;

					// Check for promise
					if (isthenable(val)) {
						// Set loop to resume (skipping next()) once promise resolved and break; tack on rejector as catch handler
						skip = true;
						return val.then(iterstep, rej);
					}
				}
				// Officially in progress
				skip = false;

				// Call function if given
				if (func !== undefined) {
					last.value = val = func(val);

					// Check for promise (again)
					if (isthenable(val)) {
						// Set loop to resume once promise resolved and break; tack on rejector as catch handler
						return val.then(iterstep, rej);
					}
				}

				if (time > 0) {
					// Schedule next iterator step after specified delay
					return delayloop(iterstep, time);
				}
				else if (time == 0) {
					// Schedule next iterator step for next event loop
					return nextloop(iterstep);
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
}

iterwait.timeouts = timeouts;

module.exports = iterwait;
