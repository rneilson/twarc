'use strict';

function tickstep (iter, last, func, res, rej) {
	if (last.done) {
		res(last.value);
	}
	else {
		try {
			// Call func for this iteration
			let newval = (func) ? func(last.value) : last.value;
			// Schedule next iterator step, passing in previous value (for generators)
			// TODO: check for thenable
			process.nextTick(tickstep, iter, iter.next(newval), func, res, rej);
		}
		catch (e) {
			// Reject original promise
			rej(e);
		}
	}
}

function itertick (iterable, iterfunc) {
	let iterator = iterable[Symbol.iterator]();

	return new Promise(function (resolve, reject) {
		// Start iterator and schedule stepper function
		process.nextTick(tickstep, iterator, iterator.next(), iterfunc, resolve, reject);
	});
}

module.exports = itertick;
