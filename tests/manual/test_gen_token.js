const fs = require('fs');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('crypto');

const privateKey = fs.readFileSync(process.env.PCM_ASSERTION_KEY || 'certs/sp-client-assertion.key');
const clientId = process.env.PCM_CLIENT_ID || 'pcm-sp-local-0001';
const audience = process.env.TOKEN_AUD || 'https://pcm-core:3000/token';

const assertion = jwt.sign({
    sub: clientId,
    iss: clientId,
    aud: audience,
    jti: uuidv4()
}, privateKey, { algorithm: 'ES256', expiresIn: '5m' });

console.log(assertion);
