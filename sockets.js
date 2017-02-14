var socketIO = require('socket.io'),
    uuid = require('node-uuid'),
    crypto = require('crypto'),
    mysql = require('mysql');


module.exports = function(server, config) {
    var people = {};
    var rooms = {};
    var clients = {};

    var io = socketIO.listen(server, { log: true, origins: '*:*' });
    var connection = mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'medic360'
    });
    connection.connect(function(err) {
        if (err) {
            console.error('error connecting: ' + err.stack);
            return;
        }

        console.log('MySQL', 'Connected');
    });


    io.sockets.on('connection', function(client) {
        client.resources = {
            screen: false,
            video: true,
            audio: false
        };

        // pass a message to another id
        client.on('message', function(details) {
            if (!details) return;

            var otherClient = io.to(details.to);
            if (!otherClient) return;

            details.from = client.id;
            otherClient.emit('message', details);
            //if (details.type === 'joined')
            //    console.log(details);
        });

        client.on('shareScreen', function() {
            client.resources.screen = true;
        });

        client.on('unshareScreen', function(type) {
            client.resources.screen = false;
            removeFeed('screen');
        });

        client.on('join', join);

        client.on('getUsers', function() {
            io.to(client.id).emit('usersList', peopleInRoom(people[client.id].room.id, true));
        });

        client.on('kick', function(id) {
            io.to(id).emit('kicked');
        });

        client.on('promote', function(id) {
            io.to(id).emit('promoted');
        });

        function removeFeed(type) {
            if (client.room) {
                io.sockets.in(client.room).emit('remove', {
                    id: client.id,
                    type: type
                });
                if (!type) {
                    client.leave(client.room);
                    client.room = undefined;
                    var user = people[client.id];
                    delete people[client.id];
                    delete clients[client.id];
                    io.sockets.to(user.room.alias).emit('userLeft', peopleInRoom(user.room.id, true));
                    console.log('user left');
                    connection.query('DELETE FROM room_users WHERE user_id=0', function(error, results, fields) {
                        if (error) console.log(error);
                    });
                }
            }
        }

        function join(data, cb) {
            connection.query('SELECT * FROM rooms', function(error, results, fields) {
                if (error) throw error;
                var room = results.find(function(item) { return item.alias === data.roomname; });

                if (room) {
                    // check if maximum number of clients reached
                    if (config.rooms && config.rooms.maxClients > 0 && clientsInRoom(data.roomname) >= config.rooms.maxClients) {
                        safeCb(cb)({ error: true, message: 'Room is full' }, null);
                        return;
                    }
                    // leave any existing rooms
                    removeFeed();
                    safeCb(cb)(null, describeRoom(data, room, client));
                    client.join(data.roomname);
                    client.room = data.roomname;
                } else {
                    safeCb(cb)({ error: true, message: 'Room not found' }, null);
                    return;
                }
            });
        }

        // we don't want to pass "leave" directly because the
        // event type string of "socket end" gets passed too.
        client.on('disconnect', function() {
            removeFeed();
        });
        client.on('leave', function() {
            removeFeed();
        });

        client.on('create', function(name, cb) {
            if (arguments.length == 2) {
                cb = (typeof cb == 'function') ? cb : function() {};
                name = name || uuid();
            } else {
                cb = name;
                name = uuid();
            }
            // check if exists
            var room = io.nsps['/'].adapter.rooms[name];
            if (room && Object.keys(room).length) {
                safeCb(cb)('Room already taken !');
            } else {
                join(name);
                safeCb(cb)(null, name);
            }
        });

        // support for logging full webrtc traces to stdout
        // useful for large-scale error monitoring
        client.on('trace', function(data) {
            console.log('trace', JSON.stringify(
                [data.type, data.session, data.prefix, data.peer, data.time, data.value]
            ));
        });


        // tell client about stun and turn servers and generate nonces
        client.emit('stunservers', config.stunservers || []);

        // create shared secret nonces for TURN authentication
        // the process is described in draft-uberti-behave-turn-rest
        var credentials = [];
        // allow selectively vending turn credentials based on origin.
        var origin = client.handshake.headers.origin;
        if (!config.turnorigins || config.turnorigins.indexOf(origin) !== -1) {
            config.turnservers.forEach(function(server) {
                var hmac = crypto.createHmac('sha1', server.secret);
                // default to 86400 seconds timeout unless specified
                var username = Math.floor(new Date().getTime() / 1000) + (server.expiry || 86400) + "";
                hmac.update(username);
                credentials.push({
                    username: username,
                    credential: hmac.digest('base64'),
                    urls: server.urls || server.url
                });
            });
        }
        client.emit('turnservers', credentials);
    });


    function describeRoom(data, room, client) {
        var connectionDate = new Date().toISOString().slice(0, 19).replace('T', ' ');
        connection.query('INSERT INTO room_users VALUES(NULL,' + room.id + ',0,"' + connectionDate + '", NULL)', function(error, results, fields) {
            if (error) console.log(error);
        });
        people[client.id] = {
            user: data,
            room: JSON.parse(JSON.stringify(room))
        };
        clients[client.id] = client;
        // Standard simplewebrtc behaviour & my mix
        var _adapter = io.nsps['/'].adapter;
        var _clients = _adapter.rooms[data.roomname] || {};
        var _result = {
            clients: {},
            people: peopleInRoom(room.id)
        };

        io.sockets.to(room.alias).emit('userJoined', peopleInRoom(room.id, true));

        Object.keys(_clients).forEach(function(id) { _result.clients[id] = _adapter.nsp.connected[id].resources; });
        return _result;
    }

    function peopleInRoom(roomId, toArray) {
        var result = {};
        Object.keys(people).forEach(function(id) {
            if (people[id].room.id == roomId) {
                result[id] = people[id];
                result[id].client = { id: clients[id].id };
            }
        });
        if (toArray) {
            var users = [];
            for (var key in people) {
                users.push(people[key]);
            }
            return users;
        }
        return result;
    }

    function clientsInRoom(name) {
        return io.sockets.clients(name).length;
    }

};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function() {};
    }
}


function removeOne(array, predicate) {
    for (var i = 0; i < array.length; i++) {
        if (predicate(array[i])) {
            return array.splice(i, 1);
        }
    }
}

function removeAll(array, predicate) {
    var removed = [];

    for (var i = 0; i < array.length;) {

        if (predicate(array[i])) {
            removed.push(array.splice(i, 1));
            continue;
        }

        i++;
    }

    return removed;
}