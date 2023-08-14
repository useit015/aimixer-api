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
const mysql = require('mysql2');
const axios = require('axios');

const wp = require('./utils/wordpress');
const s3 = require('./utils/s3')
const ai = require('./utils/ai')
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

/*
 * REST API Service
 */


const app = express();
app.use(express.static('public'));
app.use(express.json({limit: '200mb'})); 
app.use(cors());

const handleGetTagsTitles = async (req, res) => {
  const { token, content } = req.body;
  const info = auth.validateToken(token);
  if (info === false) return res.status(401).json('unauthorized');
  const { accountId, email, username, domain } = info;

  const tt = await ai.getTagsAndTitles(content);

  return res.status(200).json(tt);
}

app.get('/', (req, res) => {
    res.send('Hello, World!');
});
app.post('/getTagsTitles', (req, res) => handleGetTagsTitles(req, res))

const httpsServer = https.createServer({
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath),
  }, app);
  

httpsServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${listenPort}`);
});

/*
 * Socket Service
 */

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
      source: meta.source,
      contents: meta.contents,
      creations: meta.creations,
      customInstructions: meta.customInstructions
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
    customInstructions: '',
    length: 'longForm',
    source: 'googleSearch',
    contents: [],
    creations: [],
  }

  let q = `INSERT INTO bowls (id, account_id, name, creator, domain, meta) VALUES ('${id}', '${accountId}', ${mysql.escape(name)}, '${email}', '${domain}', '${JSON.stringify(meta)}')`;
  let r = await query(q);
  if (r === false) return socket.emit('alert', 'Could not add bowl');

  socket.emit('addBowl', {
    id, name, creator: email, domain, accountId, output: meta.output, customInstructions: '', length: meta.length, source: meta.source, contents: [], creations: []
  })

}

const addCreation = async (creation, bowlId, socket) => {
  let q = `SELECT meta FROM bowls WHERE id = '${bowlId}'`;
  let r = await query(q);

  if (!r.length) return false;

  const meta = JSON.parse(r[0].meta);

  meta.creations.push(creation);

  q = `UPDATE bowls SET meta = ${mysql.escape(JSON.stringify(meta))} WHERE id = '${bowlId}'`;

  r = await query(q);

  if (r !== false) socket.emit('addCreation', {bowlId, creation});

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

  q = `UPDATE bowls SET meta = ${mysql.escape(JSON.stringify(meta))} WHERE id = ${mysql.escape(bowlId)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not add content to bowl');

  return socket.emit('addContentToBowl', {bowlId, content});
}

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

  q = `UPDATE bowls SET meta = ${mysql.escape(JSON.stringify(meta))} WHERE id = ${mysql.escape(bowlId)}`;

  r = await query(q);

  if (r === false) return socket.emit('alert', 'Could not add content to bowl');

  return socket.emit('changeContentDate', {bowlId, contentId, date});
}

const getTitlesAndText = async (content) => {
  let url;
  if (typeof content.infoLink !== 'undefined') url = content.infoLink;
  else url = content.link;
  const { title } = content;
  try {
    const response = await axios.get(url);
    return {title, text: response.data, type: content.type, subType: content.subType}
  } catch(err) {
    console.error(err);
    return {
      title, text: '', type: content.type, subType: content.subType
    }
  }
}

const getNewsArticleFromTranscript = async (results, length, s3Folder, socket) => {  
  /*
   * Clean the transcript
   */

  socket.emit('message', 'Cleaning transcript');
  let prompt = `"""The transcript below was generated by ai in the following format: Speaker Name: Utterance. The Speaker Names preceded by a colon are accurate. Correct the transcript utterances as follows. Correct the sentences where people stutter to make them read smoothly. Rewrite numbers and numeric references in human friendly format. The company producing this transcript is PYMNTS and its website is PYMNTS.com.  Be sure to return the entire corrected transcript including all speaker names and all their corrected utterances.\n\nTranscript:\n${results[0].text}"""\n`;

  let response = await ai.getChatText(prompt);
  console.log('CLEANED TRANSCRIPT');
  
  /*
   * Extract the facts and quotes
   */
  const promises = [];

  socket.emit('message', 'Extracting Facts');

  prompt = `"""Make a list of 50 facts that can be extracted from the following transcript:\n\nTranscript:\n${response}\n"""\n`;
  promises.push(ai.getChatText(prompt))
  
  prompt = `"""Extract 10 interesting quotes from from the following transcript. The return format must be stringified JSON in the following format: {
    quotes: array of third-party quotes in the following format {
      speaker: the identity of the speaker goes here,
      affiliation: the organization that the speaker is affiliated with goes here,
      quote: the speaker's quote goes here
    }\n\nTranscript:\n${response}.\n"""\n`;
  promises.push(ai.getChatJSON(prompt));

  response = await Promise.all(promises);
  const facts = response[0];
  const quotes = response[1];

  console.log('FACTS, NOTIONS, ETC', facts, quotes);

  /*
   * Write intial article
   */

  socket.emit('message', 'Writing initial version of the article');
  prompt = `"""Using 1200 words, write a news article in a journalistic tone from the Facts and 5 Quotes provided below:\n\n[Facts]:\n${facts}\n\n[Quotes]:\n${JSON.stringify(quotes)}\n"""\n`;
  console.log(prompt);
  response = await ai.getChatText(prompt);
  console.log('INITIAL ARTICLE', response);

  const newsArticle = convertTextToHTML(response);
  const link = s3.uploadHTML(newsArticle, s3Folder, `creation--${uuidv4()}.html`);
  return link;

  /*
   * Rewrite article
   */

}

const getNewsArticle = async (results, length, s3Folder, socket) => {
  if (results[0].type === 'transcript') return getNewsArticleFromTranscript(results, length, s3Folder, socket);
  
  let prompt = results.length === 1 ? `"""Below is a Document. ` : `Below are Documents. `;
  prompt += `In ${length}, write a news article in a journalistic tone using information from `;
  prompt += results.length === 1 ? `the document.\n\n` : `the documents.\n\n`;
  for (let i = 0; i < results.length; ++i) {
    prompt += i < results.length - 1 ? `Document "${results[i].title}":\n${results[i].text}\n\n"` : `Document "${results[i].title}":\n${results[i].text}"""\n`;
  }
  try {
    let newsArticle = await ai.getChatText(prompt);
    newsArticle = convertTextToHTML(newsArticle);
    const link = s3.uploadHTML(newsArticle, s3Folder, `creation--${uuidv4()}.html`);
    return link;
  } catch (err) {
    console.error(err);
    return false;
  }
}

const getBlogPost = async (results, length, s3Folder) => {
  let prompt = results.length === 1 ? `"""Below is a Document. ` : `Below are Documents. `;
  prompt += `In ${length}, write an HTML blog post using information from `;
  prompt += results.length === 1 ? `the document. ` : `the documents. `;
  prompt += `Use headings, subheadings, tables, bullets, and bold to organize the information.\n\n`
  for (let i = 0; i < results.length; ++i) {
    prompt += i < results.length - 1 ? `Document "${results[i].title}":\n${results[i].text}\n\n"` : `Document "${results[i].title}":\n${results[i].text}"""\n`;
  }
  try {
    let blogPost = await ai.getChatText(prompt);
    const link = s3.uploadHTML(blogPost, s3Folder, `creation--${uuidv4()}.html`);
    return link;
  } catch (err) {
    console.error(err);
    return false;
  }
}

const customInstructions = async (results, prompt, s3Folder) => {
  prompt = `"""${prompt}\n\n`;
  for (let i = 0; i < results.length; ++i) {
    prompt += i < results.length - 1 ? `Document "${results[i].title}":\n${results[i].text}\n\n"` : `Document "${results[i].title}":\n${results[i].text}"""\n`;
  }
  try {
    let creation = await ai.getChatText(prompt);
    const link = s3.uploadHTML(creation, s3Folder, `creation--${uuidv4()}.html`);
    return link;
  } catch (err) {
    console.error(err);
    return false;
  }
}

const convertTextToHTML = text => {
  const paragraphs = text.split("\n");
  for (let i = 0; i < paragraphs.length; ++i) paragraphs[i] = `<p>${paragraphs[i]}</p>`;
  return paragraphs.join("\n");
}

const handleMix = async ({login, bowls, mix, bowlId}, socket) => {
  socket.emit('spinnerStatus', true);
  try {
    const { token } = login;
    const info = auth.validateToken(token);
    if (info === false) {
      socket.emit('spinnerStatus', false);
      return socket.emit('alert', 'Login expired.');
    }
    const { accountId, email, username, domain } = info;

    console.log('handleMix', info);
    const s3Folder = `${accountId}/${bowlId}`

    const currentBowl = bowls.find(b => b.id === bowlId);
    if (!currentBowl) {
      socket.emit('spinnerStatus', false);
      return socket.emit('alert', 'Could not find bowl to mix');
    }
    const { contents } = currentBowl;

    // Get titles and text
    let promises = [];
    for (let i = 0; i < contents.length; ++i) promises.push(getTitlesAndText(contents[i]));
    let results = await Promise.all(promises);

    // Convert desired length to English
    let outputLength;
    switch (currentBowl.length) {
      case 'longForm':
        outputLength = "1200 words";
        break;

      default:
        socket.emit('spinnerStatus', false);
        return socket.emit('alert', `Unknown content length: ${currentBowl.length}`);
    }

    // Use AI to generate desired creation
    let creation;
    switch(currentBowl.output) {
      case 'newsArticle':
        creation = await getNewsArticle(results, outputLength, s3Folder, socket);
        break;
      case 'blogPost':
        creation = await getBlogPost(results, outputLength, s3Folder);
        break;
      case 'custom':
        creation = await customInstructions(results, currentBowl.customInstructions, s3Folder);
        break;
      default:
        return socket.emit('alert', `Unknown output type: ${currentBowl.output}`)
    }

    if (creation === false) {
      socket.emit('spinnerStatus', false);
      return socket.emit('alert', "Could not mix contents into the desired creation");
    }

    const result = await addCreation(creation, bowlId, socket);
    socket.emit('spinnerStatus', false);

    console.log('creation', creation);

  } catch (err) {
    console.error(err);
    socket.emit('spinnerStatus', false);
    socket.emit('alert', "Could not mix contents");
  }


}

const handleDeleteContent = async ({token, bowlId, contentId}, socket) => {
  try {
    
    const info = auth.validateToken(token);
    if (info === false) return socket.emit('alert', 'Login expired.');
    
    let q = `SELECT meta FROM bowls WHERE id = ${mysql.escape(bowlId)}`;

    let r = await query(q);

    if (!r.length) return socket.emit('alert', 'Datbase error. Could not remove content.');

    let meta = JSON.parse(r[0].meta);

    meta.contents = meta.contents.filter(c => c.id !== contentId);

    q = `UPDATE bowls SET meta = ${mysql.escape(JSON.stringify(meta))} WHERE id = ${mysql.escape(bowlId)}`;

    r = await query(q);

    if (r === false) return socket.emit('alert', 'Datbase error 002. Could not remove content.');

    socket.emit('deleteContent', {bowlId, contentId});

  } catch (err) {
    console.error(err)
    return socket.emit('alert', 'Unable to delete content');
  }
}

const handleWordpresUpload = async (data, socket) => {
  const { password, token, title, postType, content } = data;
  const info = auth.validateToken(token);
  if (info === false) return socket.emit('alert', 'Login expired.');
  const { accountId, email, username, domain } = info;

  try {
    const result = wp.createPost('delta.pymnts.com', username, password, title, content, postType);
    if (result === false) socket.emit('alert', "Could not upload to WordPress");
    socket.emit('spinnerStatus', false);
  } catch (err) {
    console.error(err);
    socket.emit('alert', "Could not upload to WordPress");
    socket.emit('spinnerStatus', false);
  }
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
  socket.on('addContentToBowl', data => handleAddContentToBowl(data, socket));
  socket.on('changeContentDate', state => handleChangeContentDate(state, socket));
  socket.on('deleteContent', data => handleDeleteContent(data, socket));
  socket.on('wordpressUpload', data => handleWordpresUpload(data, socket));
  socket.on('mix', data => handleMix(data, socket));

  // socket.emit('message', 'Login Successful');
  // socket.emit('alert', 'Ooops');

});

