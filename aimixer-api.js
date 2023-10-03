const {
  privateKeyPath,
  fullchainPath,
  mysqlOptions,
  listenPort
} = require('./config');
const express = require('express');
const https = require('https');
const cors = require('cors');
const fs = require('fs');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2');
const axios = require('axios');
const lodash = require('lodash');
const wp = require('./utils/wordpress');
const s3 = require('./utils/s3');
const ai = require('./utils/ai');
const auth = require('./utils/auth');
const mixIt = require('./utils/mixIt');

const pool = mysql.createPool(mysqlOptions);

const query = q => {
  return new Promise((resolve, reject) => {
    pool.query(q, function (err, rows, fields) {
      console.error(err);
      if (err) return resolve(false);
      resolve(rows);
    });
  });
};

/*
 * REST API Service
 */

const app = express();
app.use(express.static('public'));
app.use(express.json({ limit: '200mb' }));
app.use(cors());

const handleGetTagsTitles = async (req, res) => {
  const { token, content } = req.body;
  const info = auth.validateToken(token);
  if (info === false) return res.status(401).json('unauthorized');
  const { accountId, email, username, domain } = info;

  const tt = await ai.getTagsAndTitles(content);

  return res.status(200).json(tt);
};

app.get('/', (req, res) => {
  res.send('Hello, World!');
});
app.post('/getTagsTitles', (req, res) => handleGetTagsTitles(req, res));

const httpsServer = https.createServer(
  {
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath)
  },
  app
);

httpsServer.listen(listenPort, '0.0.0.0', () => {
  console.log(`HTTPS Server running on port ${listenPort}`);
});

/*
 * Socket Service
 */

const io = socketio(httpsServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const handleGetBowls = async (token, socket) => {
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `SELECT domain FROM corporate_domains WHERE domain = ${mysql.escape(
    domain
  )}`;
  let r = await query(q);

  const room = r.length ? domain : email;

  socket.meta = { room };

  socket.join(room);

  console.log(socket.id, 'joined', room);

  q = `SELECT id, name, creator, domain, meta FROM bowls WHERE account_id = ${mysql.escape(
    accountId
  )} OR domain = ${mysql.escape(domain)}`;

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
      source: meta.source,
      contents: meta.contents,
      creations: meta.creations,
      customInstructions: meta.customInstructions,
      input: meta.input ? lodash.cloneDeep(meta.input) : {},
      misc: meta.misc ? lodash.cloneDeep(meta.misc) : {}
    };
  });

  socket.emit('setBowls', bowls);
};

const handleAddBowl = async (data, socket) => {
  const { name, token } = data;
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;
  const id = uuidv4();
  const meta = {
    output: 'newsArticle',
    customInstructions: '',
    length: 'longForm',
    source: 'googleSearch',
    contents: [],
    creations: [],
    input: {
      mode: 'siteSearch',
      term: '',
      site: '',
      timePeriod: 'last_month',
      index: 'google_search_news',
      results: []
    },
    misc: {}
  };

  let q = `INSERT INTO bowls (id, account_id, name, creator, domain, meta) VALUES ('${id}', '${accountId}', ${mysql.escape(
    name
  )}, '${email}', '${domain}', '${JSON.stringify(meta)}')`;
  let r = await query(q);
  if (r === false) return socket.emit('alert', 'Could not add bowl');

  socket.emit('addBowl', {
    id,
    name,
    creator: email,
    domain,
    accountId,
    output: meta.output,
    customInstructions: '',
    length: meta.length,
    source: meta.source,
    contents: [],
    creations: []
  });
};

const addCreation = async (creation, bowlId, socket) => {
  let q = `SELECT meta FROM bowls WHERE id = '${bowlId}'`;
  let r = await query(q);

  if (!r.length) return false;

  const meta = JSON.parse(r[0].meta);

  meta.creations.push(creation);

  q = `UPDATE bowls SET meta = ${mysql.escape(
    JSON.stringify(meta)
  )} WHERE id = '${bowlId}'`;

  r = await query(q);

  if (r !== false) socket.emit('addCreation', { bowlId, creation });
};

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
};

const handleUpdateBowlName = async (data, socket) => {
  const { id, name, token } = data;
  console.log(id, token);
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `UPDATE bowls SET name = ${mysql.escape(
    name
  )} WHERE id = ${mysql.escape(id)}`;

  let r = await query(q);

  if (r !== false) return socket.emit('changeBowlName', { id, name });
};

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

  q = `UPDATE bowls SET meta = ${mysql.escape(
    JSON.stringify(meta)
  )} WHERE id = ${mysql.escape(id)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl output');

  return socket.emit('changeBowlOutput', { id, output });
};

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

  q = `UPDATE bowls SET meta = ${mysql.escape(
    JSON.stringify(meta)
  )} WHERE id = ${mysql.escape(id)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl length');

  return socket.emit('changeBowlLength', { id, length });
};

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

  q = `UPDATE bowls SET meta = ${mysql.escape(
    JSON.stringify(meta)
  )} WHERE id = ${mysql.escape(id)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change bowl source');

  return socket.emit('changeBowlSource', { id, source });
};

const handleAddContentToBowl = async (data, socket) => {
  const { token, bowlId, content } = data;
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `SELECT meta FROM bowls WHERE id = ${mysql.escape(bowlId)}`;

  let r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not add content to bowl');

  let meta = JSON.parse(r[0].meta);

  meta.contents.push(content);

  q = `UPDATE bowls SET meta = ${mysql.escape(
    JSON.stringify(meta)
  )} WHERE id = ${mysql.escape(bowlId)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not add content to bowl');

  return socket.emit('addContentToBowl', { bowlId, content });
};

const handleChangeContentDate = async (data, socket) => {
  const { token, bowlId, contentId, date } = data;
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  let q = `SELECT meta FROM bowls WHERE id = ${mysql.escape(bowlId)}`;

  let r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not change content date');

  let meta = JSON.parse(r[0].meta);

  let test = meta.contents.find(c => c.id === contentId);

  if (!test) return socket.emit('alert', 'Could not change content date');

  test.date = date;

  q = `UPDATE bowls SET meta = ${mysql.escape(
    JSON.stringify(meta)
  )} WHERE id = ${mysql.escape(bowlId)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not add content to bowl');

  return socket.emit('changeContentDate', { bowlId, contentId, date });
};

const getTitlesAndText = async content => {
  let url;
  if (typeof content.infoLink !== 'undefined') url = content.infoLink;
  else url = content.link;
  const { title } = content;
  try {
    console.log('getting', url);
    const response = await axios.get(url);
    return {
      title,
      text: response.data,
      type: content.type,
      subType: content.subType,
      origURL: content.origURL ? content.origURL : ''
    };
  } catch (err) {
    console.error(err);
    return {
      title,
      text: '',
      type: content.type,
      subType: content.subType,
      origURL: content.origURL ? content.origURL : ''
    };
  }
};

const customInstructions = async (results, prompt, s3Folder) => {
  prompt = `"""${prompt}\n\n`;
  for (let i = 0; i < results.length; ++i) {
    prompt +=
      i < results.length - 1
        ? `Document "${results[i].title}":\n${results[i].text}\n\n"`
        : `Document "${results[i].title}":\n${results[i].text}"""\n`;
  }
  try {
    let creation = await ai.getChatText(prompt);
    const link = s3.uploadHTML(
      creation,
      s3Folder,
      `creation--${uuidv4()}.html`
    );
    return link;
  } catch (err) {
    console.error(err);
    return false;
  }
};

const assignWordLength = length => {
  switch (length) {
    case 'concise':
      return '300 words';
      break;

    case 'shortForm':
      return '600 words';
      break;

    case 'longForm':
      return '1200 words';
      break;

    case 'exhaustive':
      return '4000 words';
      break;

    default:
      return '1200 words';
  }
};

const displayContentFacts = contents => {
  contents.forEach(content => {
    console.log(JSON.stringify(content.facts, null, 4));
  });
};

const handleMix = async ({ login, mix, currentBowl }, socket) => {
  socket.emit('spinnerStatus', true);
  try {
    const { token } = login;
    const info = auth.validateToken(token);
    if (info === false) {
      socket.emit('spinnerStatus', false);
      return socket.emit('alert', 'Login expired.');
    }
    const { accountId, email, username, domain } = info;
    const s3Folder = `${accountId}/${currentBowl.id}`;
    const { contents } = currentBowl;

    if (contents[0].facts) displayContentFacts(contents);

    // Get titles and text
    let promises = [];
    for (let i = 0; i < contents.length; ++i)
      promises.push(getTitlesAndText(contents[i]));
    let results = await Promise.all(promises);

    console.log('RESULTS', results);

    // Convert desired length to English

    outputLength = assignWordLength(currentBowl.length);

    // Use AI to generate desired creation
    let creation;
    switch (currentBowl.output) {
      case 'newsArticle':
        //creation = await mixIt.newsArticle(results, outputLength, s3Folder, socket);
        creation = await mixIt.newsArticleFromFacts(
          contents,
          outputLength,
          s3Folder,
          socket
        );

        break;
      case 'blogPost':
        creation = await mixIt.blogPost(results, outputLength, s3Folder);
        break;
      case 'custom':
        creation = await customInstructions(
          results,
          currentBowl.customInstructions,
          s3Folder
        );
        break;
      default:
        return socket.emit(
          'alert',
          `Unknown output type: ${currentBowl.output}`
        );
    }

    if (creation === false) {
      socket.emit('spinnerStatus', false);
      return socket.emit(
        'alert',
        'Could not mix contents into the desired creation'
      );
    }

    const result = await addCreation(creation, currentBowl.id, socket);
    socket.emit('spinnerStatus', false);

    console.log('creation', creation);
  } catch (err) {
    console.error(err);
    socket.emit('spinnerStatus', false);
    socket.emit('alert', 'Could not mix contents');
  }
};

const handleDeleteContent = async ({ token, bowlId, contentId }, socket) => {
  try {
    const info = auth.validateToken(token);
    if (info === false) return socket.emit('alert', 'Login expired.');

    let q = `SELECT meta FROM bowls WHERE id = ${mysql.escape(bowlId)}`;

    let r = await query(q);

    if (!r.length)
      return socket.emit('alert', 'Datbase error. Could not remove content.');

    let meta = JSON.parse(r[0].meta);

    meta.contents = meta.contents.filter(c => c.id !== contentId);

    q = `UPDATE bowls SET meta = ${mysql.escape(
      JSON.stringify(meta)
    )} WHERE id = ${mysql.escape(bowlId)}`;

    r = await query(q);

    if (r === false)
      return socket.emit(
        'alert',
        'Datbase error 002. Could not remove content.'
      );

    socket.emit('deleteContent', { bowlId, contentId });
  } catch (err) {
    console.error(err);
    return socket.emit('alert', 'Unable to delete content');
  }
};

const handleWordpresUpload = async (data, socket) => {
  const { password, token, title, postType, content, AITags, AITitles } = data;
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  try {
    const result = await wp.createPost(
      'delta.pymnts.com',
      username,
      password,
      title,
      content,
      postType,
      AITags,
      AITitles
    );
    if (result === false) socket.emit('alert', 'Could not upload to WordPress');
    socket.emit('spinnerStatus', false);
    socket.emit('message', 'WordPress content has been uploaded.');
  } catch (err) {
    console.error(err);
    socket.emit('alert', 'Could not upload to WordPress');
    socket.emit('spinnerStatus', false);
  }
};

io.on('connection', socket => {
  console.log('connected', socket.id);

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
  socket.on('addContentToBowl', data => handleAddContentToBowl(data, socket));
  socket.on('changeContentDate', state =>
    handleChangeContentDate(state, socket)
  );
  socket.on('deleteContent', data => handleDeleteContent(data, socket));
  socket.on('wordpressUpload', data => handleWordpresUpload(data, socket));
  socket.on('mix', data => handleMix(data, socket));

  // socket.emit('message', 'Login Successful');
  // socket.emit('alert', 'Ooops');
});
