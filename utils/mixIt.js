require('dotenv').config();

const { v4: uuidv4 } = require('uuid');

const wp = require('./wordpress');
const s3 = require('./s3')
const ai = require('./ai')
const auth = require('./auth');

const convertTextToHTML = text => {
  const paragraphs = text.split("\n");
  for (let i = 0; i < paragraphs.length; ++i) paragraphs[i] = `<p>${paragraphs[i]}</p>`;
  return paragraphs.join("\n");
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
  
  exports.newsArticle = async (results, length, s3Folder, socket) => {
    if (results[0].type === 'transcript') return getNewsArticleFromTranscript(results, length, s3Folder, socket);
    
    let prompt = results.length === 1 ? `"""Below is a Document. ` : `Below are Documents. `;
    prompt += `In ${length}, write a news article in a journalistic tone using information from `;
    prompt += results.length === 1 ? `the document. ` : `the documents. `;
    prompt += `The returned content must use as many links and quotes as possible.\n\n`
    for (let i = 0; i < results.length; ++i) {
      prompt += i < results.length - 1 ? `Document "${results[i].title}":\n${results[i].text}\n\n"` : `Document "${results[i].title}":\n${results[i].text}"""\n`;
    }
    try {
      let newsArticle = await ai.getChatText(prompt);
      newsArticle += "\n\nThird Party Links\n\n";
      for (let i = 0; i < results.length; ++i) if (results[i].origURL) newsArticle += results[i].origURL + "\n";
      newsArticle = convertTextToHTML(newsArticle);
      const link = s3.uploadHTML(newsArticle, s3Folder, `creation--${uuidv4()}.html`);
      return link;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  exports.blogPost = async (results, length, s3Folder) => {
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
  