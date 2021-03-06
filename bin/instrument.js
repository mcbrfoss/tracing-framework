#!/usr/bin/env node
/**
 * Copyright 2013 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Instrumentation tool.
 * Manually instruments code for producing wtf-calls files, or runs as a proxy
 * to instrument code on the fly.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

var child_process = require('child_process');
var fs = require('fs');
var http = require('http');
var https = require('https');
var os = require('os');
var path = require('path');
var querystring = require('querystring');
var url = require('url');

var falafel = require('falafel');


/**
 * Transforms Javascript source code into a instrumented version.
 * @param {number} moduleId Module ID, [0-126].
 * @param {string} url URL of the source code.
 * @param {string} sourceCode Source code.
 * @return {string} Transformed code.
 */
function transformCode(moduleId, url, sourceCode, trackHeap) {
  console.log('Instrumenting ' + url + ' (' + sourceCode.length + 'b)...');
  var startTime = Date.now();

  // This code is stringified and then embedded in each output file.
  // It cannot capture any state.
  // TODO(benvanik): clean up, make support nodejs too.
  // TODO(benvanik): put in an external file, have a HUD, etc.
  var sharedInitCode = '(' + (function(global, trackHeap) {
    var dataMagnitude = 26; // 2^26 = 67 million records
    var dataSize = 1 << dataMagnitude;
    var dataMask = dataSize - 1;
    global.__wtfm = window.__wtfm || {};
    global.__wtfd = window.__wtfd || new Int32Array(1 << dataMagnitude);
    global.__wtfi = window.__wtfi || 0;
    if (trackHeap) {
      var getHeapUsage = new Function('return %GetHeapUsage()');
      global.__wtfEnter = function(id) {
        __wtfd[__wtfi++ & dataMask] = id;
        __wtfd[__wtfi++ & dataMask] = getHeapUsage();
      };
      global.__wtfExit = function(id) {
        __wtfd[__wtfi++ & dataMask] = -id;
        __wtfd[__wtfi++ & dataMask] = getHeapUsage();
      };
    } else {
      global.__wtfEnter = function(id) {
        __wtfd[__wtfi++ & dataMask] = id;
      };
      global.__wtfExit = function(id) {
        __wtfd[__wtfi++ & dataMask] = -id;
      };
    }
    global.__resetTrace = function() {
      global.__wtfi = 0;
    };
    global.__saveTrace = function(opt_filename) {
      var a = document.createElement('a');
      a.download = opt_filename || (Date.now() + '.wtf-calls');

      var euri = window.location.href;
      var etitle =
          window.document.title.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      var attributes = trackHeap ? '[{"name": "heapSize", "units": "bytes"}]' : '[]';
      var headerText = '{' +
          '"version": 1,' +
          '"context": {"uri": "' + euri + '", "title": "' + etitle + '"},' +
          '"metadata": {' +
          '  "attributes": ' + attributes +
          '},' +
          '"modules": ' + JSON.stringify(global.__wtfm) + '}';
      var headerLength = headerText.length;
      var header = new Uint8Array(4 + headerLength);
      header[0] = (headerLength) & 0xFF;
      header[1] = (headerLength >>> 8) & 0xFF;
      header[2] = (headerLength >>> 16) & 0xFF;
      header[3] = (headerLength >>> 24) & 0xFF;
      for (var n = 0; n < headerLength; n++) {
        header[4 + n] = headerText.charCodeAt(n) & 0xFF;
      }

      var padLength = 0;
      var i = 4 + headerLength;
      if (i % 4) {
        padLength = 4 - (i % 4);
      }
      var padBytes = new Uint8Array(padLength);

      var contents = global.__wtfd.subarray(0, window.__wtfi);
      a.href = URL.createObjectURL(new Blob([
        header,
        padBytes,
        contents
      ], {
        type: 'application/octet-stream'
      }));
      var e = document.createEvent('MouseEvents');
      e.initMouseEvent(
          'click',
          true, false, window, 0, 0, 0, 0, 0,
          false, false, false, false, 0, null);
      a.dispatchEvent(e);
    };
  }).toString() + ')(window, ' + trackHeap + ');';

  // Attempt to guess the names of functions.
  function getFunctionName(node) {
    // Simple case of:
    // function foo() {}
    if (node.id) {
      return node.id.name;
    }

    // var foo = function() {};
    if (node.parent.type == 'VariableDeclarator') {
      if (node.parent.id) {
        return node.parent.id.name;
      }
      console.log('unknown var decl', node.parent);
      return null;
    }

    // foo = function() {};
    // Bar.foo = function() {};
    //
    if (node.parent.type == 'AssignmentExpression') {
      // We are the RHS, LHS is something else.
      var left = node.parent.left;
      if (left.type == 'MemberExpression') {
        // Bar.foo = function() {};
        // left.object {type: 'Identifier', name: 'Bar'}
        // left.property {type: 'Identifier', name: 'foo'}
        // Object can be recursive MemberExpression's:
        // Bar.prototype.foo = function() {};
        // left.object {type: 'MemberExpression', ...}
        // left.property {type: 'Identifier', name: 'foo'}
        return left.source();
      } else if (left.type == 'Identifier') {
        return left.name;
      }
      console.log('unknown assignment LHS', left);
      return null;
    }

    //console.log('unknown fn construct', node);

    // TODO(benvanik): support jscompiler prototype alias:
    // _.$JSCompiler_prototypeAlias$$ = _.$something;
    // ...
    // _.$JSCompiler_prototypeAlias$$.$unnamed = function() {};

    return null;
  };

  // Walk the entire document instrumenting functions.
  var nextFnId = (moduleId << 24) + 1;
  var nextAnonymousName = 0;
  var fns = [];
  // We have two modes of rewriting - wrapping the whole function in a try/catch
  // and explicitly handling all return statements. The try/catch mode is more
  // generally correct (since it means we'll always have an "exit" entry), but
  // can't be used in heap tracking mode because try/catch disables
  // optimization, which drammatically changes memory generation behavior.
  var tryCatchMode = !trackHeap;
  var targetCode = falafel(sourceCode, function(node) {
    if (node.type == 'BlockStatement') {
      var parent = node.parent;

      // function foo() {}
      var isDecl = parent.type == 'FunctionDeclaration';
      // = function [optional]() {}
      var isExpr = parent.type == 'FunctionExpression';
      if (!isDecl && !isExpr) {
        return;
      }

      // Guess function name or set to some random one.
      var name = getFunctionName(parent);
      if (name) {
        // Strip off any junk.
        // jscompiler adds a _.$ prefix sometimes.
        if (name.indexOf('_.$') == 0) {
          name = name.substr(3);
        }
      }
      if (!name || !name.length) {
        name = 'anon' + moduleId + '$' + nextAnonymousName++;
      }

      var fnId = nextFnId++;
      fns.push(fnId);
      fns.push('"' + name.replace(/\"/g, '\\"') + '"');
      fns.push(node.range[0]);
      fns.push(node.range[1]);

      if (tryCatchMode) {
        node.update([
          '{',
          '__wtfEnter(' + fnId + ');',
          'try{' + node.source() + '}finally{',
          '__wtfExit(' + fnId + ');',
          '}}'
        ].join(''));
      } else {
        node.update([
          '{',
          'var __wtfId=' + fnId + ',__wtfRet;__wtfEnter(__wtfId);',
          node.source(),
          '__wtfExit(__wtfId);',
          '}'
        ].join(''));
      }
    } else if (!tryCatchMode && node.type == 'ReturnStatement') {
      if (node.argument) {
        node.update([
          '__wtfRet=',
          node.argument.source(),
          '; __wtfExit(__wtfId);',
          'return __wtfRet;'
        ].join(''));
      } else {
        node.update('__wtfExit(__wtfId); return;');
      }
    } else if (node.type == 'Program') {
      node.update([
        node.source(),
        //'\n//@ sourceMappingURL=' + url
        //'\n//@ sourceURL=' + url
      ].join(''))
    }
  });

  var endTime = Date.now() - startTime;
  console.log('  ' + endTime + 'ms');
  return [
    sharedInitCode,
    '__wtfm[' + moduleId + '] = {' +
        '"src": "' + url + '",' +
        '"fns": [' + fns.join(',\n') + ']};',
    targetCode.toString()
  ].join('');
};


/**
 * Processes a single input file.
 * @param {boolean} trackHeap Use heap tracking mode.
 * @param {string} inputPath Input file path.
 * @param {string=} opt_outputPath Output file path.
 */
function processFile(trackHeap, inputPath, opt_outputPath) {
  // Setup output path.
  var outputPath = opt_outputPath;
  if (!opt_outputPath) {
    var ext = path.extname(inputPath);
    if (ext.length) {
      outputPath = inputPath.substr(0, inputPath.length - ext.length) +
          '.instrumented' + ext;
    } else {
      outputPath = inputPath + '.instrumented.js';
    }
  }

  var sourceCode = fs.readFileSync(inputPath).toString();

  // TODO(benvanik): support setting the module ID?
  var targetCode = transformCode(0, inputPath, sourceCode, trackHeap);

  console.log('Writing ' + outputPath + '...');
  fs.writeFileSync(outputPath, targetCode);
  fs.chmodSync(outputPath, fs.statSync(inputPath).mode);
};


/**
 * Launches a proxy server.
 * @param {boolean} trackHeap Use heap tracking mode.
 * @param {number} httpPort HTTP port.
 * @param {number} httpsPort HTTPS port.
 * @param {{privateKey: string, certificate: string}} certs Certificates.
 */
function startServer(trackHeap, httpPort, httpsPort, certs) {
  console.log('Launching proxy server...');
  console.log('   http: ' + httpPort);
  console.log('  https: ' + httpsPort);

  // Injects a node stream by buffering all data, transforming it, and writing
  // it back out.
  // Module IDs are assigned on demand and rotate 0-126.
  var nextModuleId = 0;
  function injectStream(url, source, target) {
    var moduleId = nextModuleId++;
    if (nextModuleId >= 127) {
      nextModuleId = 0;
    }
    var sourceCode = '';
    source.on('data', function(chunk) {
      sourceCode += chunk;
    });
    source.on('end', function() {
      var targetCode = transformCode(moduleId, url, sourceCode, trackHeap);
      target.end(targetCode);
    });
  };

  // Handles both HTTP and HTTPS requests.
  function handler(req, res) {
    // Support both the ?url= mode and the X-WTF-URL header.
    var targetUrl;
    if (req.headers['x-wtf-url']) {
      targetUrl = req.headers['x-wtf-url'];
    } else {
      var parsedUrl = url.parse(req.url, true);
      var query = parsedUrl.query;
      targetUrl = query.url;
    }
    if (!targetUrl || targetUrl.indexOf('http') != 0) {
      res.writeHead(404, ['Content-Type', 'text/plain']);
      res.end();
      return;
    }

    var targetModule = targetUrl.indexOf('https') == 0 ? https : http;
    targetModule.get(targetUrl, function(originalRes) {
      // Pull out content type to see if we are interested in it.
      var supportedContentType = false;
      var contentType = originalRes.headers['content-type'];
      if (contentType.indexOf(';') != 0) {
        contentType = contentType.substr(0, contentType.indexOf(';'));
      }
      switch (contentType) {
        case 'text/javascript':
        case 'application/javascript':
          supportedContentType = true;
          break;
      }

      // Also parse the URL - some servers don't return content type for some
      // reason.
      var supportedPath = false;
      var contentUrl = url.parse(targetUrl);
      if (path.extname(contentUrl.pathname) == '.js') {
        supportedPath = true;
      }

      if (supportedContentType || supportedPath) {
        var headers = [];
        for (var key in originalRes.headers) {
          if (key == 'content-length') {
            continue;
          }
          headers.push([key, originalRes.headers[key]]);
        }
        res.writeHead(originalRes.statusCode, headers);
        injectStream(targetUrl, originalRes, res);
      } else {
        console.log('Pass-through: ' + targetUrl, contentType);
        res.writeHead(originalRes.statusCode, originalRes.headers);
        originalRes.pipe(res);
      }
    }).on('error', function(e) {
      console.log(e);
      res.writeHead(404, ['Content-Type', 'text/plain']);
      res.end(e.message);
    });
  };

  // HTTP server.
  var httpServer = http.createServer(handler);
  httpServer.listen(httpPort);

  // HTTPS server.
  var httpsServer = https.createServer({
    key: certs.privateKey,
    cert: certs.certificate
  }, handler);
  httpsServer.listen(httpsPort);

  console.log('Server ready, use ctrl-c to exit...');
  console.log('');
};


/**
 * Either loads or generates the HTTPS certs/keys.
 * @param {function({privateKey: string, certificate: string})} callback
 *     Callback that receives the certs.
 */
function getHttpsCerts(callback) {
  // Certs are stored under a tmp path, ensure it exists.
  var certPath = path.join(os.tmpDir(), 'wtf-instrument-certs');
  if (!fs.existsSync(certPath)) {
    fs.mkdirSync(certPath);
  }
  var cnfPath = path.join(certPath, 'openssl.cnf');
  var privateKeyPath = path.join(certPath, 'privatekey.pem');
  var certRequestPath = path.join(certPath, 'certrequest.csr');
  var certificatePath = path.join(certPath, 'certificate.pem');

  // If the cert files are not found, create them.
  if (!fs.existsSync(path.join(certPath, 'privatekey.pem'))) {
    console.log('Generating new HTTPS certs...');
    // openssl genrsa -out privatekey.pem 1024
    // openssl req -new -key privatekey.pem -out certrequest.csr
    // openssl x509 -req -in certrequest.csr -signkey privatekey.pem -out certificate.pem

    // Note that to do this sliently we need to write this conf file.
    fs.writeFileSync(cnfPath, [
      '[req]',
      'prompt = no',
      'distinguished_name = req_distinguished_name',
      '[req_distinguished_name]',
      'C = GB',
      'ST = Test State',
      'L = Test Locality',
      'O = Org Name',
      'OU = Org Unit Name',
      'CN = Common Name',
      'emailAddress = test@email.com'
    ].join('\n'));

    child_process.exec([
      'openssl genrsa -out ' + privateKeyPath + ' 1024',
      'openssl req -config ' + cnfPath + ' -new -key ' + privateKeyPath + ' -out ' + certRequestPath,
      'openssl x509 -req -in ' + certRequestPath + ' -signkey ' + privateKeyPath + ' -out ' + certificatePath,
    ].join(' && '), function(error, stdout, stderr) {
      readCerts();
    });
  } else {
    readCerts();
  }

  function readCerts() {
    var privateKey = fs.readFileSync(
        path.join(certPath, 'privatekey.pem')).toString();
    var certificate = fs.readFileSync(
        path.join(certPath, 'certificate.pem')).toString();
    callback({
      privateKey: privateKey,
      certificate: certificate
    });
  };
};


function main(argv) {
  if (argv.length < 3) {
    console.log('usage:');
    console.log('  wtf-instrument --server [--trackheap]');
    console.log('  wtf-instrument [--trackheap] source.js [source.instrumented.js]');
    return;
  }

  var isServer = false;
  var trackHeap = false;
  var n = 2;
  for (; n < argv.length && argv[n].indexOf('--') == 0; n++) {
    if (argv[n] == '--server') {
      isServer = true;
    } else if (argv[n] == '--trackheap') {
      trackHeap = true;
    } else {
      console.log('Unkown arg: "' + argv[n] +
                  '", valid args: "--server", "--trackheap"');
      process.exit(1);
    }
  }
  console.log('n = ' + n)

  if (isServer) {
    // TODO(benvanik): read ports from args/etc
    getHttpsCerts(function(certs) {
      startServer(8081, 8082, certs);
    });
  } else {
    processFile(trackHeap, argv[n], argv[n + 1]);
  }
};


main(process.argv);
