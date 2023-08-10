require('dotenv').config();
const listenPort = 5000;
const hostname = 'app.aimixer.io'
const privateKeyPath = `/etc/sslkeys/aimixer.io/aimixer.io.key`;
const fullchainPath = `/etc/sslkeys/aimixer.io/aimixer.io.pem`;

const express = require('express');
const https = require('https');
const cors = require('cors');
const fs = require('fs');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2');

const auth = require('./utils/auth');

const { MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE, JWT_PASSWORD } = process.env;

const mysqlOptions = {
  host: MYSQL_HOST,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10, // max idle connections, the default value is the same as `connectionLimit`
  idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
}

const pool = mysql.createPool(mysqlOptions);

const query = q => {
  return new Promise((resolve, reject) => {
    pool.query(q, function(err, rows, fields) {
      console.error(err);
      if (err) return resolve(false);
      resolve(rows)
    });
  })
}


const app = express();
app.use(express.static('public'));
app.use(express.json({limit: '200mb'})); 
app.use(cors());

app.get('/', (req, res) => {
    res.send('Hello, World!');
});

const httpsServer = https.createServer({
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath),
  }, app);
  

httpsServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${listenPort}`);
});

const io = socketio(httpsServer, {
  cors: {
    origin: ["http://localhost:8100", 'https://app.aimixer.io'],
    methods: ["GET", "POST"]
  }
});


const handleGetBowls = async (token, socket) => {
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `SELECT domain FROM corporate_domains WHERE domain = ${mysql.escape(domain)}`;
  let r = await query(q);

  const room = r.length ? domain : email;

  socket.meta = {room}

  socket.join(room);

  console.log(socket.id, 'joined', room);

  q = `SELECT id, name, creator, domain, meta FROM bowls WHERE account_id = ${mysql.escape(accountId)} OR domain = ${mysql.escape(domain)}`;

  r = await query(q);

  if (!r.length) return socket.emit('setBowls', []);

  const bowls = r.map(b => {
    const meta = JSON.parse(b.meta);
    return {
      id: b.id,
      name: b.name,
      creator: b.creator,
      domain: b.domain,
      accountId,
      output: meta.output,
      length: meta.length,
      source: meta.source
    }
  })

  socket.emit('setBowls', bowls);

}

const handleAddBowl = async (data, socket) => {
  const { name, token } = data;
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;
  const id = uuidv4();
  const meta = {
    output: 'newsArticle',
    length: 'longForm',
    source: 'googleSearch',
    contents: []
  }

  let q = `INSERT INTO bowls (id, account_id, name, creator, domain, meta) VALUES ('${id}', '${accountId}', ${mysql.escape(name)}, '${email}', '${domain}', '${JSON.stringify(meta)}')`;
  let r = await query(q);
  if (r === false) return socket.emit('alert', 'Could not add bowl');

  socket.emit('addBowl', {
    id, name, creator: email, domain, accountId, output: meta.output, length: meta.length, source: meta.source, contents: []
  })

}

const handleDeleteBowl = async (data, socket) => {
  const { id, token } = data;
  console.log(id, token);
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `DELETE FROM bowls WHERE id = ${mysql.escape(id)}`;

  console.log(q);

  let r = await query(q);

  if (r !== false) {
    console.log('sending deleteBowl event');
    socket.emit('deleteBowl', id);
  }
}

const handleUpdateBowlName = async (data, socket) => {
  const { id, name, token } = data;
  console.log(id, token);
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `UPDATE bowls SET name = ${mysql.escape(name)} WHERE id = ${mysql.escape(id)}`;

  let r = await query(q);

  if (r !== false) return socket.emit('changeBowlName', {id, name});

}

const handleChangeBowlOutput = async (data, socket) => {
  const { id, output, token } = data;
  console.log(id, token);
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `SELECT meta FROM bowls WHERE id = ${mysql.escape(id)}`;

  let r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl output');

  let meta = JSON.parse(r[0].meta);

  meta.output = output;

  q = `UPDATE bowls SET meta = ${mysql.escape(JSON.stringify(meta))} WHERE id = ${mysql.escape(id)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl output');

  return socket.emit('changeBowlOutput', {id, output});

}

const handleChangeBowlLength = async (data, socket) => {
  const { id, length, token } = data;
  console.log(id, token);
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `SELECT meta FROM bowls WHERE id = ${mysql.escape(id)}`;

  let r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl length');

  let meta = JSON.parse(r[0].meta);

  meta.length = length;

  q = `UPDATE bowls SET meta = ${mysql.escape(JSON.stringify(meta))} WHERE id = ${mysql.escape(id)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl length');

  return socket.emit('changeBowlLength', {id, length});

}

const handleChangeBowlSource = async (data, socket) => {
  const { id, source, token } = data;
  console.log(id, token);
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `SELECT meta FROM bowls WHERE id = ${mysql.escape(id)}`;

  let r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl source');

  let meta = JSON.parse(r[0].meta);

  meta.source = source;

  q = `UPDATE bowls SET meta = ${mysql.escape(JSON.stringify(meta))} WHERE id = ${mysql.escape(id)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl source');

  return socket.emit('changeBowlSource', {id, source});

}

io.on("connection", (socket) => {
  console.log('connected', socket.id)
 
  // receive a message from the client
  // socket.on("hello from client", (...args) => {
  //   // ...
  // });

 
  socket.on('getBowls', token => handleGetBowls(token, socket));
  socket.on('addBowl', data => handleAddBowl(data, socket));
  socket.on('deleteBowl', data => handleDeleteBowl(data, socket));
  socket.on('updateBowlName', data => handleUpdateBowlName(data, socket));
  socket.on('changeBowlOutput', data => handleChangeBowlOutput(data, socket));
  socket.on('changeBowlLength', data => handleChangeBowlLength(data, socket));
  socket.on('changeBowlSource', data => handleChangeBowlSource(data, socket));


  // socket.emit('message', 'Login Successful');
  // socket.emit('alert', 'Ooops');

});

