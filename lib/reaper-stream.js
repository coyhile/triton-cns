/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

module.exports = ReaperStream;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var restify = require('restify-clients');
var EventEmitter = require('events').EventEmitter;

var consts = require('./consts');

var FSM = require('mooremachine').FSM;

/* Attempt to reap VMs that haven't been visited in REAP_TIME seconds. */
var DEFAULT_REAP_TIME = 3600;

/*
 * The Reaper FSM's job is to periodically go around looking for any VMs that
 * we haven't processed an update about in a while (REAP_TIME seconds) and
 * force us to reconsider them by pushing them into the pipeline.
 *
 * It has to do this without overwhelming the pipeline, so it throttles its
 * insertions using a timer, and adjusts that timer upwards every time the
 * pipeline is full (.push() returns false).
 *
 * Each time the reaper runs, it first gathers up a list of *all* VMs known
 * to CNS (state listVms). Then it works slowly through this list (state next),
 * checking each to see if it needs to be reaped (checkLastVisited, checkReaped)
 * and then finally dispensing it into the pipeline (fetchAndPush). In between,
 * it sleeps in order to throttle the rate at which it dispenses them.
 *
 * If the fetchAndPush found that the pipeline is full, it moves to the
 * sleep_full state, which sleeps and adjusts the sleep time upwards for the
 * next sleep (up to maxSleep). If it found the pipeline was not full, it
 * moves to the sleep state, which sleeps and justs the sleep time downwards
 * until it hits minSleep. In this way if there is a transient condition that
 * causes the pipeline to fill up for a short period, we will back off during
 * that time, and then resume our normal reaping rate when it clears.
 *
 * Maintaining a reasonably high reaping rate is important for CNS' correctness
 * -- if any changefeed notifications are missed about removed VMs, this is the
 * only backstop that pulls them out of DNS.
 */
function ReaperFSM(strm, opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'ReaperStream'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.vmapi_opts, 'config.vmapi_opts');
	assert.string(opts.config.vmapi_opts.address, 'vmapi_opts.address');

	assert.optionalObject(opts.agent, 'options.agent');

	assert.object(opts.client, 'options.client');
	this.redis = opts.client;

	this.stream = strm;
	this.remaining = [];
	this.vmuuid = undefined;
	this.lastError = undefined;
	this.retries = 3;
	this.onTimer = false;
	this.minSleep = 100;
	this.sleep = 100;
	this.maxSleep = 10000;
	this.reapTime = DEFAULT_REAP_TIME;
	this.listCursor = '0';

	this.client = restify.createJsonClient(utils.getRestifyClientOptions({
		url: 'http://' + opts.config.vmapi_opts.address,
		agent: opts.agent
	}));

	FSM.call(this, 'idle');
}
util.inherits(ReaperFSM, FSM);

ReaperFSM.prototype.fetch = function (uuid, cb) {
	this.client.get('/vms/' + uuid, function (err, req, res, obj) {
		if (err) {
			cb(err);
			return;
		}
		utils.cleanVM(obj);
		obj.origin = 'reaper';
		cb(null, obj);
	});
};

ReaperFSM.prototype.start = function () {
	this.onTimer = true;
	this.emit('startAsserted');
};

ReaperFSM.prototype.wake = function () {
	this.emit('wakeAsserted');
};

ReaperFSM.prototype.state_idle = function (S) {
	this.listCursor = '0';
	S.on(this, 'startAsserted', function () {
		S.gotoState('listVms');
	});
	if (this.onTimer) {
		S.timeout(this.reapTime*1000, function () {
			S.gotoState('listVms');
		});
	}
};

ReaperFSM.prototype.state_listVms = function (S) {
	var self = this;
	S.timeout(10000, function () {
		self.lastError = new Error(
		    'Timed out waiting for redis response');
		S.gotoState('listError');
	});

	this.redis.scan(this.listCursor, 'COUNT', 50, 'MATCH', 'vm:*',
	    S.callback(function (err, resp) {
		if (err) {
			self.lastError = err;
			S.gotoState('listError');
			return;
		}
		self.listCursor = resp[0];
		var keys = resp[1];
		var pushed = 0;

		for (var i = 0; i < keys.length; ++i) {
			var parts = keys[i].split(':');
			if (parts.length === 2 && parts[0] === 'vm') {
				self.remaining.push(parts[1]);
				++pushed;
			}
		}

		self.log.debug('pushed %d candidates for reaping (out of %d ' +
		    'keys, %d total on queue)', pushed, keys.length,
		    self.remaining.length);

		if (self.listCursor === '0') {
			S.gotoState('next');
		} else {
			S.gotoState('listVms');
		}
	}));
};

ReaperFSM.prototype.state_listError = function (S) {
	this.listCursor = '0';
	this.log.error(this.lastError,
	    'error while listing VMs in redis, retry in 1s');
	S.timeout(1000, function () {
		S.gotoState('listVms');
	});
};

ReaperFSM.prototype.state_next = function (S) {
	this.retries = 3;
	if (this.remaining.length > 0) {
		this.vmuuid = this.remaining.shift();
		S.gotoState('checkLastVisited');
	} else {
		this.log.debug('reaping complete');
		S.gotoState('idle');
	}
};

ReaperFSM.prototype.state_checkLastVisited = function (S) {
	var self = this;
	var log = self.log.child({uuid: self.vmuuid});
	S.timeout(1000, function () {
		self.lastError = new Error(
		    'Timed out waiting for redis response');
		S.gotoState('checkError');
	});

	this.redis.hget('vm:' + self.vmuuid, 'last_visit',
	    S.callback(function (err, val) {
		if (err) {
			self.lastError = err;
			S.gotoState('checkError');
			return;
		}

		if (val === null) {
			log.warn({queue: self.remaining.length},
			    'vm has no last_visited record, skipping');
			S.gotoState('next');
			return;
		}

		var now = Math.round((new Date()).getTime() / 1000);
		var lastVisited = parseInt(val, 10);
		if (now - lastVisited > self.reapTime) {
			log.trace({queue: self.remaining.length},
			    'reaping, last visited %d sec ago',
			    (now - lastVisited));
			S.gotoState('checkReaped');
		} else {
			S.gotoState('next');
		}
	}));
};

ReaperFSM.prototype.state_checkReaped = function (S) {
	var self = this;
	var log = self.log.child({uuid: self.vmuuid});
	S.timeout(1000, function () {
		self.lastError = new Error(
		    'Timed out waiting for redis response');
		S.gotoState('checkError');
	});

	this.redis.hget('vm:' + self.vmuuid, 'reaped',
	    S.callback(function (err, val) {
		if (err) {
			self.lastError = err;
			S.gotoState('checkError');
			return;
		}

		/*
		 * If we found something, this is the second time we've
		 * visited this VM and it's still destroyed. We can
		 * forget that it existed now.
		 */
		if (val !== null) {
			/*
			 * Double-check that the last_recs is actually empty,
			 * though, before we do.
			 *
			 * If we throw away a VM and it still has last_recs
			 * entries then it's very difficult to ever get rid of
			 * the records about that VM in future, so we're extra
			 * paranoid.
			 */
			self.redis.hget('vm:' + self.vmuuid, 'last_recs',
			    S.callback(function (err2, val2) {
				if (err2 || val2 === null || val2 === '{}') {
					self.redis.del('vm:' + self.vmuuid);
					S.gotoState('next');
					return;
				}

				/*
				 * Mostly this would happen because we crashed
				 * or broke while processing this VM for
				 * removal last time. We'll retry it here.
				 */
				log.warn({ last_recs: val2 }, 'tried to ' +
				    'delete reaped VM, but last_recs is not ' +
				    'empty');
				S.gotoState('fetchAndPush');
			}));
			return;
		}

		S.gotoState('fetchAndPush');
	}));
};

ReaperFSM.prototype.state_fetchAndPush = function (S) {
	var self = this;
	S.timeout(5000, function () {
		self.lastError = new Error(
		    'Timed out waiting for VMAPI response');
		S.gotoState('checkError');
	});
	this.fetch(this.vmuuid, S.callback(function (err, obj) {
		if (err) {
			self.lastError = new Error('Error from VMAPI: ' +
			    err.name + ': ' + err.message);
			self.lastError.name = 'VMAPIError';
			self.lastError.origin = err;
			S.gotoState('checkError');
			return;
		}

		if (self.stream.push(obj) === false) {
			S.gotoState('sleep_full');
			return;
		}

		if (obj.state === 'destroyed' || obj.destroyed ||
		    obj.state === 'failed' || obj.state === 'incomplete') {
			self.redis.hset('vm:' + self.vmuuid, 'reaped', 'yes');
		}

		S.gotoState('sleep');
	}));
};

ReaperFSM.prototype.state_sleep_full = function (S) {
	var self = this;
	S.timeout(self.sleep, function () {
		/*
		 * Pipeline is full, and stayed full for our entire sleep
		 * interval (we didn't get a wake-up). Increase our sleep
		 * interval to avoid taking up the whole available throughput
		 * of the pipeline.
		 */
		self.sleep *= 2;
		if (self.sleep > self.maxSleep) {
			self.log.warn('reaper backing off to maximum,' +
			    ' pipeline seems to be persistently full' +
			    ' (is this a bug?)');
			self.sleep = self.maxSleep;
		}
		S.gotoState('next');
	});
	S.on(this, 'wakeAsserted', function () {
		S.gotoState('next');
	});
};

ReaperFSM.prototype.state_sleep = function (S) {
	var self = this;
	/*
	 * If we weren't full, we always wait for our entire sleep interval
	 * and ignore wakeups, so that we don't dominate the pipeline's
	 * available throughput.
	 */
	S.timeout(self.sleep, function () {
		S.gotoState('next');
	});
	S.on(this, 'wakeAsserted', function () {
		/*
		 * If the pipeline has emptied out, head down towards our
		 * lowest sleep interval -- it might have been a transient
		 * traffic jam that's cleared up now.
		 */
		self.sleep /= 2;
		if (self.sleep < self.minSleep)
			self.sleep = self.minSleep;
	});
};

ReaperFSM.prototype.state_checkError = function (S) {
	var self = this;
	--(self.retries);
	var log = self.log.child({uuid: self.vmuuid,
	    retries_remaining: self.retries});
	if (self.retries > 0) {
		log.error(self.lastError,
		    'error while checking vm, retrying in 1s');
		S.timeout(1000, function () {
			S.gotoState('checkLastVisited');
		});
	} else {
		log.error(self.lastError,
		    'error while checking vm, out of retries -- will skip');
		S.timeout(5000, function () {
			S.gotoState('next');
		});
	}
};

function ReaperStream(opts) {
	this.fsm = new ReaperFSM(this, opts);
	var streamOpts = {
		objectMode: true
	};
	stream.Readable.call(this, streamOpts);
}
util.inherits(ReaperStream, stream.Readable);

ReaperStream.prototype._read = function () {
	this.fsm.start();
	this.fsm.wake();
};

ReaperStream.prototype.start = function () {
	this.fsm.start();
};

ReaperStream.prototype.setReapTime = function (v) {
	assert.number(v, 'reapTime');
	assert.ok(v > 0 && v < 24*3600);
	this.fsm.reapTime = v;
};
