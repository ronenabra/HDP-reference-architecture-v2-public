const fs = require('fs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const privateKey = fs.readFileSync('certs/sp-client.key');
const clientId = 'http://pcm.fhir.health.gov.il/Organization/org-sp';
const audience = process.env.TOKEN_AUD || 'https://pcm-core:3000/token';

const assertion = jwt.sign({
    sub: clientId,
    iss: clientId,
    aud: audience,
    jti: uuidv4()
}, privateKey, { algorithm: 'RS256', expiresIn: '5m' });

console.log(assertion);
