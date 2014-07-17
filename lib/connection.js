/**
 * @file Main file for a Memcache Connection
 */

var debug = require('debug')('memcache-plus:connection');

var _ = require('lodash'),
    assert = require('assert'),
    carrier = require('carrier'),
    misc = require('./misc'),
    net = require('net'),
    Promise = require('bluebird'),
    Queue = require('collections/deque'),
    util = require('util');

/**
 * Connection constructor
 *
 * With the supplied options, connect.
 *
 * @param {object} opts - The options for this Connection instance
 */
function Connection(opts) {
    opts = opts || {};

    _.defaults(opts, {
        host: 'localhost',
        port: '11211',
        reconnect: true
    });

    this.host = opts.host;
    this.port = opts.port;

    this.queue = new Queue();

    if (opts.onConnect) {
        this.onConnect = opts.onConnect;
    }
    this.reconnect = opts.reconnect;
    this.disconnecting = false;
    this.ready = false;
    this.backoff = opts.backoff || 10;

    this.connect();
}

/**
 * Disconnect connection
 */
Connection.prototype.disconnect = function() {
    this.ready = false;
    this.disconnecting = true;
    this.client.end();
};

/**
 * Initialize connection
 *
 * @api private
 */
Connection.prototype.connect = function() {
    var self = this;
    var params = {
        port: this.port
    };

    if (this.host) {
        params.host = this.host;
    }

    debug('connecting to host %s:%s', params.host, params.port);

    // If a client already exists, we just want to reconnect
    if (this.client) {
        this.client.connect(params);

    } else {
        // Initialize a new client, connect
        this.client = net.connect(params);

        // If reconnect is enabled, we want to re-initiate connection if it is ended
        if (this.reconnect) {
            this.client.on('close', function() {
                this.ready = false;
                // Wait before retrying and double each time. Backoff starts at 10ms and will
                // plateau at 1 minute.
                if (this.backoff < 60000) {
                    this.backoff *= 2;
                }
                debug('connection to memcache lost, reconnecting in %sms...', this.backoff);
                setTimeout(function() {
                    // Only want to do this if a disconnect was not triggered intentionally
                    if (!self.disconnecting) {
                        debug('attempting to reconnect to memcache now.', this.backoff);
                        self.client.destroy();
                        self.connect();
                    }
                }, this.backoff);
            });
        }
    }
    Promise.promisifyAll(this.client);

    this.client.on('connect', function() {
        debug('successfully (re)connected!');
        this.ready = true;
        // Reset backoff if we connect successfully
        this.backoff = 10;

        // If an onConnect handler was specified, execute it
        if (this.onConnect) {
            this.onConnect();
            this.flushQueue();
        } else {
            this.flushQueue();
        }
    }.bind(this));

    carrier.carry(this.client, this.read.bind(this));
};

Connection.prototype.read = function(data) {
    debug('got data: %s', data.toString());
    var deferred = this.queue.peek();
    if (data.toString().substr(0, 5) === 'ERROR') {
        if (this.queue.toArray().length > 0) {
            // We only want to do this if the last thing was not an error,
            // as if it were, we already would have notified about the error
            // last time so now we want to ignore it
            this.queue.shift();
            deferred.reject(new Error(util.format('Memcache returned an error: %s\r\nFor key %s', data.toString(), deferred.key)));
            this.data = null;
        }
    } else {
        if (data.toString().substr(0, 5) === 'VALUE') {
            // Do nothing, this is just metadata. May want to somehow store this
            // and send it back somehow in the future
            debug('Got some metadata');
        } else if (data.toString().substr(0, 3) === 'END') {
            this.queue.shift();
            deferred.resolve(this.data);
            this.data = null;
        } else if (data.toString().substr(0, 6) === 'STORED' || data.toString().substr(0, 7) === 'DELETED') {
            this.queue.shift();
            deferred.resolve(data);
            this.data = null;
        } else if (data.toString().substr(0, 9) === 'NOT_FOUND') {
            this.queue.shift();
            deferred.resolve(data);
            this.data = null;
        } else if (data.toString() !== '') {
            this.data = data;
        }
    }
};

Connection.prototype.flushQueue = function() {
    if (this.writeBuffer && this.writeBuffer.length > 0) {
        debug('flushing connection write buffer');
        // @todo Watch out for and handle how this behaves with a very long buffer
        while(this.writeBuffer.length > 0) {
            this.client.write(this.writeBuffer.shift());
        }
    }
};

Connection.prototype.write = function(str) {
    debug('sending data: %s', str);
    this.writeBuffer = this.writeBuffer || new Queue();
    // If for some reason this connection is not yet ready and a request is tried,
    // we don't want to fire it off so we write it to a buffer and then will fire
    // them off when we finally do connect. And even if we are connected we don't
    // want to fire off requests unless the write buffer is emptied. So if say we
    // buffer 100 requests, then connect and chug through 10, there are 90 left to
    // be flushed before we send it new requests so we'll just keep pushing on the
    // end until it's flushed
    if (this.ready && this.writeBuffer.length > 0) {
        this.client.write(str);
        this.client.write('\r\n');
    } else {
        this.writeBuffer.push(str);
        this.writeBuffer.push('\r\n');
        // Check if we should flush this queue. Useful in case it gets stuck for
        // some reason
        if (this.ready) {
            this.flushQueue();
        }
    }
};

Connection.prototype.autodiscovery = function() {
    debug('starting autodiscovery');
    var deferred = misc.defer('autodiscovery');
    this.queue.push(deferred);

    this.write('config get cluster');
    return deferred.promise
        .then(function(data) {
            debug('got autodiscovery response from elasticache');
            // Elasticache returns hosts as a string like the following:
            // victor.di6cba.0001.use1.cache.amazonaws.com|10.10.8.18|11211 victor.di6cba.0002.use1.cache.amazonaws.com|10.10.8.133|11211
            // We want to break it into the correct pieces
            var hosts = data.toString().split(' ');
            return hosts.map(function(host) {
                host = host.split('|');
                return util.format('%s:%s', host[0], host[2]);
            });
        });
};

/**
 * set() - Set a value on this connection
 */
Connection.prototype.set = function(key, val, ttl) {
    debug('set %s:%s', key, val);
    assert(typeof key === 'string', 'Cannot set in memcache with a not string key');
    assert(key.length < 250, 'Key must be less than 250 characters long');

    // @todo ensure val is a string or Buffer before saving, or stringify object

    ttl = ttl || 0;

    // What we're doing here is a bit tricky as we need to invert control.
    // We are going to basically return a Promise that itself is made up of a
    // chain of Promises, most resolved here (the initial communication with
    // memcache), but the last is not resolved until some time in the future.
    // This Promise is put into a queue which will be processed whenever the
    // socket responds (usually immediately). This because we don't know
    // exactly when it's going to respond since it's an event emitter. So we
    // are doing some funky promise trickery to convert event emmitter into
    // Promise/or Callback. Since all actions in this library share the same
    // queue, order should be maintained and this trick should work!
   
    var deferred = misc.defer(key);
    this.queue.push(deferred);

    val = new Buffer(val);

    // First send the metadata for this request
    this.write(util.format('set %s 0 %d %d', key, ttl, val.length));
    // Then the actual value
    this.write(val);

    return deferred.promise
        .then(function(data) {
            // data will be a buffer
            if (data.toString() !== 'STORED') {
                throw new Error(util.format('Something went wrong with the set. Expected STORED, got :%s:', data.toString()));
            } else {
                return Promise.resolve();
            }
        });
};

/**
 * get() - Get a value on this connection
 *
 * @param {String} key - The key for the value to retrieve
 * @returns {Promise}
 */
Connection.prototype.get = function(key) {
    debug('get %s', key);
    // Do the get
    var deferred = misc.defer(key);
    this.queue.push(deferred);

    this.write(util.format('get %s', key));

    return deferred.promise
        // .timeout() // @todo add this as a setting
        .then(function(data) {
            if (data) {
                return data.toString();
            } else {
                return null;
            }
        });
};

/**
 * delete() - Delete value for this key on this connection
 *
 * @param {String} key - The key to delete
 * @returns {Promise}
 */
Connection.prototype.delete = function(key) {
    debug('delete %s', key);
    // Do the delete
    var deferred = misc.defer(key);
    this.queue.push(deferred);

    this.write(util.format('delete %s', key));

    return deferred.promise
        .then(function(v) {
            if (v === 'DELETED') {
                return true;
            } else {
                return false;
            }
        });
        // .timeout() // @todo add this as a setting
};

module.exports = Connection;
