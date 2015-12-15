/*---------------------------------------------------------------------------
  Copyright 2015 Microsoft Corporation.
 
  This is free software; you can redistribute it and/or modify it under the
  terms of the Apache License, Version 2.0. A copy of the License can be
  found in the file "license.txt" at the root of this distribution.
---------------------------------------------------------------------------*/

if (typeof define !== 'function') { var define = require('amdefine')(module) }
define([],function() {

var Path        = require("path");
var Cp          = require("child_process");
var Util        = require("./util.js");
var Log         = require("./log.js");
var Promise     = require("./promise.js");
var Sandbox     = require("./sandbox.js");


// -------------------------------------------------------------
// Helpers 
// -------------------------------------------------------------

// this routine replace parent directory references (..) by a .parent directory
// this is also done by Madoko with the --sandbox flag so these files will be found correctly.
function xnormalize(fpath) {
  if (!fpath) return "";
  var parts = fpath.split(/[\\\/]/g);
  var roots = [];
  parts.forEach( function(part) {
    if (!part || part===".") {
      /* nothing */
    }
    else if (part==="..") {
      if (roots.length > 0 && roots[roots.length-1] !== ".parent") {
        roots.pop(); 
      }
      else {
        roots.push(".parent");
      }
    }
    else {
      roots.push(part);
    }
  });
  return roots.join("/");
}

function encodingFromMime(mime) {
  return (mime.indexOf("text/") === 0 || mime==="application/json" ? "utf8" : "base64" );
}


// -------------------------------------------------------------
// Madoko
// -------------------------------------------------------------

var outdir   = "out";
var stdflags = "--odir=" + outdir + " --sandbox";


// Save files to be processed.
function saveFiles( userpath, files ) {
  return Promise.when( files.map( function(file) {
    var fpath = Sandbox.getSafePath(userpath,file.path);
    Log.trace("writing file: " + fpath + " (" + file.encoding + ")", 3);
    return Util.writeFile( fpath, file.content, {encoding: file.encoding, ensuredir: true } );
  }));
}


// Read madoko generated files.
// config: 
//   limits.fileSize : int 
//   mime.lookup(path)
function readFiles( config, userpath, docname, pdf, out ) {
  var ext    = Path.extname(docname);
  var stem   = docname.substr(0, docname.length - ext.length );
  var fnames = [".dimx", "-math-dvi.dim", "-math-pdf.dim", 
                "-math-dvi.tex", "-math-pdf.tex", 
                "-math-dvi.final.tex", "-math-pdf.final.tex",
                "-bib.bbl", "-bib.aux"]
                .concat( pdf ? [".pdf",".tex"] : [] )
                .map( function(s) { return Util.combine( outdir, stem + s ); });
  // find last log file
  var rxLog = /^[ \t]*log written at: *([\w\-\/\\]+\.log) *$/mig;
  var cap = rxLog.exec(out);
  var capx = cap;
  while((capx = rxLog.exec(out)) != null) {
    cap = capx;
  }
  if (cap) {
    try {
      Sandbox.getSafePath(userpath,cap[1]); // check if sandboxed
      Log.trace("add output: " + cap[1],3);
      fnames.push(cap[1]);
    }
    catch(exn) {}
  }
  //console.log("sending back:\n" + fnames.join("\n"));
  return Promise.when( fnames.map( function(fname) {
    // paranoia
    var fpath = Sandbox.getSafePath(userpath,fname);

    function readError(err) {
      if (err) Log.trace("unable to read: " + fpath);
      var mime = config.mime.lookup(fname);
      return {
        path    : fname,
        encoding: encodingFromMime(mime),
        mime    : mime,
        content : "",
      };
    };

    return Util.fstat( fpath ).then( function(stats) {
      if (!stats) return readError();
      if (stats.size > config.limits.fileSize) throw new HttpError("generated file too large: " + fname);
      return Util.readFile( fpath ).then( function(buffer) {
          var mime = config.mime.lookup(fname);
          var encoding = encodingFromMime(mime);
          Log.trace("reading: " + fpath + " (" + mime + ", " + encoding + ")");
          return {
            path: fname,
            encoding: encoding,
            mime: mime,
            content: buffer.toString(encoding),
          };
        }, function(err) {
          return readError(err);
        }
      );
    });
  }));  
}

// execute madoko program
function madokoExec( program, userpath, docname, flags, timeout ) {
  var command = program + " " + flags + " " + stdflags + " \""  + docname + "\"";
  return new Promise( function(cont) {
    Log.message("> " + command);
    Cp.exec( command, {cwd: userpath, timeout: timeout || 10000, maxBuffer: 512*1024 }, cont);
    //cont( new Error("sorry, cannot execute yet")); 
  }); 
}

// Run madoko program
// config {
//   limits { fileSize: int; timeoutPDF : ms, timeoutMath : ms }
//   mime   { lookup: (path) -> mime }
//   run    : string
//   rundir : string
// }
function madokoRunIn( config, userpath, docname, files, pdf ) {
  return saveFiles( userpath, files ).then( function() {
    Sandbox.getSafePath(userpath,docname); // is docname safe?
    var flags = " -vv --verbose-max=0 -mmath-embed:512 -membed:" + (pdf ? "512" : "0") + (pdf ? " --pdf" : "");    
    var timeout = (pdf ? config.limits.timeoutPDF : config.limits.timeoutMath);    
    var startTime = Date.now();    
    return madokoExec( config.run, userpath, docname, flags, timeout ).then( function(stdout,stderr) {
      var endTime = Date.now();
      var out = stdout + "\n" + stderr + "\n";
      Log.message(out);
      Log.info("madoko run: " + ((endTime - startTime + 999)/1000).toFixed(3) + "s");
      return readFiles( config, userpath, docname, pdf, out ).then( function(filesOut) {
        return {
          files: filesOut.filter( function(file) { return (file.content && file.content.length > 0); } ),
          stdout: stdout,
          stderr: stderr,
        };
      });
    }, function(err,stdout,stderr) {
      Log.info("madoko failed: \nstdout: " + stdout + "\nstderr: " + stderr + "\n");
      if (err) Log.info(err.toString()); 
      err.stdout = stdout;
      err.stderr = stderr;
      throw err;
    });
  });
}

// Run madoko:
// config {
//   limits { fileSize: int; timeoutPDF : ms, timeoutMath : ms; rmdirDelay : ms }
//   mime   { lookup: (path) -> mime }
//   run    : string
//   rundir : string
// }
function madokoRun( config, params ) {
  var docname  = params.docname || "document.mdk";
  var files    = params.files   || [];
  var pdf      = params.pdf     || false;
  var now = new Date();
  var sub = now.toISOString().substr(0,10) + "-" + now.getTime().toString(16).toUpperCase();
  var userpath = Util.combine( config.rundir, sub );
  Log.info("madoko run: " + userpath);
  return Util.ensureDir( userpath ).then( function() {
    return madokoRunIn( config, userpath, docname, files, pdf ).always( function() {
      setTimeout( function() {
        Util.removeDirAll( userpath ).then( null, function(err) {
          Log.message( "unable to remove: " + userpath + ": " + err.toString() );
        });
      }, config.limits.rmdirDelay);
    });
  }, function(err) {
    // Log.trace("error: " + err.toString());
    throw err;
  });
}


// module interface
return {
  madokoRun: madokoRun,
};

});