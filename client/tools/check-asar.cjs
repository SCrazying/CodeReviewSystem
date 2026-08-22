const fs = require('fs');
const a = fs.readFileSync('D:/AI/Code/CodeReviewSystem/client/dist/win-unpacked/resources/app.asar');
console.log('含 this.config.llmTimeout(坏代码):', a.includes(Buffer.from('this.config.llmTimeout')) ? 'FAIL 在' : 'OK 不在');
console.log('含 buildNativeEnv(新代码):', a.includes(Buffer.from('buildNativeEnv')) ? 'OK 在' : 'FAIL 缺');
