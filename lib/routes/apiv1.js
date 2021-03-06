'use strict';

var sf = require('sf');
var async = require('async');
var inflection = require('inflection');
var myutil = require('../util');

module.exports = function (app) {
  app.get('/apiv1/server/info', getServerInfo);
  app.get('/apiv1/key/:key', getKeyDetails);
  app.post('/apiv1/key/:key', postKey);
  app.post('/apiv1/keys/:key', postKeys);
  app.get('/apiv1/keystree/:keyPrefix', getKeysTree);
  app.get('/apiv1/keystree', getKeysTree);
  app.get('/apiv1/keys/:keyPrefix', getKeys);
  app.post('/apiv1/exec', postExec);
};

function getServerInfo(req, res, next) {
  req.redisConnection.info(function (err, serverInfo) {
    if (err) {
      console.error('getServerInfo', err);
      return next(err);
    }

    var infoLines = serverInfo
      .split('\n')
      .map(function (line) {
        line = line.trim();
        var parts = line.split(':');
        return {
          key: inflection.humanize(parts[0]),
          value: parts.slice(1).join(':')
        };
      });
    res.send(JSON.stringify({
      host: req.redisConnection.host,
      port: req.redisConnection.port,
      info: infoLines
    }));
  });
}

function postExec(req, res, next) {
  var cmd = req.body.cmd;
  var parts = myutil.split(cmd);
  if (!req.redisConnection[parts[0]]) {
    return res.send("ERROR: Invalid command");
  }

  var commandName = parts[0];
  var args = parts.slice(1);
  args.push(function (err, results) {
    if (err) {
      return res.send(err.message);
    }
    if (results instanceof Array) {
      var result = '';
      for (var i = 0; i < results.length; i++) {
        result += (i + 1) + ") " + results[i] + '\n';
      }
      return res.send(result);
    }
    return res.send(JSON.stringify(results));
  });
  req.redisConnection[commandName].apply(req.redisConnection, args);
}

function getKeyDetails(req, res, next) {
  var key = req.params.key;
  console.log(sf('loading key "{0}"', key));
  req.redisConnection.type(key, function (err, type) {
    if (err) {
      console.error('getKeyDetails', err);
      return next(err);
    }

    switch (type) {
    case 'string':
      return getKeyDetailsString(key, req, res, next);
    case 'list':
      return getKeyDetailsList(key, req, res, next);
    case 'zset':
      return getKeyDetailsZSet(key, req, res, next);
    case 'hash':
      return getKeyDetailsHash(key, req, res, next);
    case 'set':
      return getKeyDetailsSet(key, req, res, next);
    }

    var details = {
      key: key,
      type: type
    };
    res.send(JSON.stringify(details));
  });
}

function getKeyDetailsString(key, req, res, next) {
  req.redisConnection.get(key, function (err, val) {
    if (err) {
      console.error('getKeyDetailsString', err);
      return next(err);
    }

    var details = {
      key: key,
      type: 'string',
      value: val
    };
    res.send(JSON.stringify(details));
  });
}

function getKeyDetailsList(key, req, res, next) {
  var startIdx = 0;
  var endIdx = startIdx + 20;
  req.redisConnection.lrange(key, startIdx, endIdx, function (err, items) {
    if (err) {
      console.error('getKeyDetailsList', err);
      return next(err);
    }

    var i = startIdx;
    items = items.map(function (item) {
      return {
        number: i++,
        value: item
      }
    });

    var details = {
      key: key,
      type: 'list',
      items: items
    };
    res.send(JSON.stringify(details));
  });
}

function getKeyDetailsHash(key, req, res, next) {
  req.redisConnection.hgetall(key, function (err, fieldsAndValues) {
    if (err) {
      console.error('getKeyDetailsHash', err);
      return next(err);
    }

    var details = {
      key: key,
      type: 'hash',
      data: fieldsAndValues
    };
    res.send(JSON.stringify(details));
  });
}

function getKeyDetailsSet(key, req, res, next) {
  req.redisConnection.smembers(key, function (err, members) {
    if (err) {
      console.error('getKeyDetailsSet', err);
      return next(err);
    }

    var details = {
      key: key,
      type: 'set',
      members: members
    };
    res.send(JSON.stringify(details));
  });
}

function getKeyDetailsZSet(key, req, res, next) {
  var startIdx = 0;
  var endIdx = startIdx + 20;
  req.redisConnection.zrange(key, startIdx, endIdx, 'WITHSCORES', function (err, items) {
    if (err) {
      console.error('getKeyDetailsZSet', err);
      return next(err);
    }

    items = mapZSetItems(items);

    var i = startIdx;
    items.forEach(function (item) {
      item.number = i++;
    });

    var details = {
      key: key,
      type: 'zset',
      items: items
    };
    res.send(JSON.stringify(details));
  });
}

function postKey(req, res, next) {
  var key = req.params.key;
  if (req.query.action === 'delete') {
    deleteKey(key, req, next, res);
  } else {
    saveKey(key, req, next, res);
  }
}

function saveKey(key, req, next, res) {
  console.log(sf('saving key "{0}"', key));
  req.redisConnection.type(key, function (err, type) {
    if (err) {
      console.error('saveKey', err);
      return next(err);
    }

    switch (type) {
    case 'string':
    case 'none':
      return posKeyDetailsString(key, req, res, next);
    default:
      return next(new Error("Unhandled type " + type));
    }
  });
}

function deleteKey(key, req, next, res) {
  console.log(sf('deleting key "{0}"', key));
  req.redisConnection.del(key, function (err) {
    if (err) {
      console.error('deleteKey', err);
      return next(err);
    }

    return res.send('ok');
  });
}

function posKeyDetailsString(key, req, res, next) {
  var val = req.body.stringValue;
  req.redisConnection.set(key, val, function (err) {
    if (err) {
      console.error('posKeyDetailsString', err);
      return next(err);
    }

    res.send('OK');
  });
}

function getKeys(req, res, next) {
  var prefix = req.params.keyPrefix;
  var limit = req.params.limit || 100;
  console.log(sf('loading keys by prefix "{0}"', prefix));
  req.redisConnection.keys(prefix, function (err, keys) {
    if (err) {
      console.error('getKeys', err);
      return next(err);
    }
    console.log(sf('found {0} keys for "{1}"', keys.length, prefix));

    if (keys.length > 1) {
      keys = myutil.distinct(keys.map(function (key) {
        var idx = key.indexOf(':', prefix.length);
        if (idx > 0) {
          return key.substring(0, idx + 1);
        }
        return key;
      }));
    }

    if (keys.length > limit) {
      keys = keys.slice(0, limit);
    }

    res.send(JSON.stringify(keys));
  });
}

function getKeysTree(req, res, next) {
  var prefix = req.params.keyPrefix;
  console.log(sf('loading keys by prefix "{0}"', prefix));
  var search;
  if (prefix) {
    search = prefix + ':*';
  } else {
    search = '*';
  }
  req.redisConnection.keys(search, function (err, keys) {
    if (err) {
      console.error('getKeys', err);
      return next(err);
    }
    console.log(sf('found {0} keys for "{1}"', keys.length, prefix));

    var lookup = {};
    var reducedKeys = [];
    keys.forEach(function (key) {
      var fullKey = key;
      if (prefix) {
        key = key.substr((prefix + ':').length);
      }
      var parts = key.split(':');
      var firstPrefix = parts[0];
      if (lookup.hasOwnProperty(firstPrefix)) {
        lookup[firstPrefix].count++;
      } else {
        lookup[firstPrefix] = {
          attr: { id: firstPrefix },
          count: parts.length === 1 ? 0 : 1
        };
        lookup[firstPrefix].fullKey = fullKey;
        if (parts.length === 1) {
          lookup[firstPrefix].leaf = true;
        }
        reducedKeys.push(lookup[firstPrefix]);
      }
    });

    reducedKeys.forEach(function (data) {
      if (data.count === 0) {
        data.data = data.attr.id;
      } else {
        data.data = data.attr.id + ":* (" + data.count + ")";
        data.state = "closed";
      }
    });

    async.forEachLimit(reducedKeys, 10, function (keyData, callback) {
      if (keyData.leaf) {
        req.redisConnection.type(keyData.fullKey, function (err, type) {
          if (err) {
            return callback(err);
          }
          keyData.attr.rel = type;
          callback();
        });
      } else {
        callback();
      }
    }, function (err) {
      if (err) {
        console.error('getKeys', err);
        return next(err);
      }
      res.send(JSON.stringify(reducedKeys));
    });
  });
}

function postKeys(req, res, next) {
  var key = req.params.key;
  if (req.query.action === 'delete') {
    deleteKeys(key, req, res, next);
  } else {
    next(new Error("Invalid action '" + req.query.action + "'"));
  }
}

function deleteKeys(keyQuery, req, res, next) {
  req.redisConnection.keys(keyQuery, function (err, keys) {
    if (err) {
      console.error('deleteKeys', err);
      return next(err);
    }

    async.forEachLimit(keys, 10, function (key, callback) {
      req.redisConnection.del(key, callback);
    }, function (err) {
      if (err) {
        console.error('deleteKeys', err);
        return next(err);
      }
      return res.send('ok');
    })
  });
}

function mapZSetItems(items) {
  var results = [];
  for (var i = 0; i < items.length; i += 2) {
    results.push({
      score: items[i + 1],
      value: items[i]
    });
  }
  return results;
}
