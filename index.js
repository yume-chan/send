/**
 * Module dependencies.
 */

const debug = require('debug')('koa-send')
const resolvePath = require('resolve-path')
const createError = require('http-errors')
const assert = require('assert')
const fs = require('mz/fs')

const {
  normalize,
  basename,
  extname,
  resolve,
  parse,
  sep
} = require('path')

/**
 * Expose `send()`.
 */

module.exports = send

/**
 * Send file at `path` with the
 * given `options` to the koa `ctx`.
 *
 * @param {Context} ctx
 * @param {String} path
 * @param {Object} [opts]
 * @return {Promise}
 * @api public
 */

async function send(ctx, path, opts = {}) {
  assert(ctx, 'koa context required')
  assert(path, 'pathname required')

  // options
  debug('send "%s" %j', path, opts)
  const root = opts.root ? normalize(resolve(opts.root)) : ''
  const trailingSlash = path[path.length - 1] === '/'
  const index = opts.index
  const maxage = opts.maxage || opts.maxAge || 0
  const immutable = opts.immutable || false
  const hidden = opts.hidden || false
  const format = opts.format !== false
  const extensions = Array.isArray(opts.extensions) ? opts.extensions : false
  const brotli = opts.brotli !== false
  const gzip = opts.gzip !== false
  const setHeaders = opts.setHeaders

  const parsedPath = parse(path)
  path = path.substr(parsedPath.root.length)

  if (setHeaders && typeof setHeaders !== 'function') {
    throw new TypeError('option setHeaders must be function')
  }

  try {
    // normalize path
    path = decode(path)
  } catch (e) {
    return ctx.throw(400, 'failed to decode')
  }

  path = resolvePath(root, path)

  // index file support
  if (trailingSlash) {
    if (index) {
      path = resolve(path, index)
    } else {
      throw createError(404, "Not Found")
    }
  } else {
    // hidden file support, ignore
    if (!hidden && isHidden(root, path)) return

    if (extensions && !await fs.exists(path)) {
      const list = [].concat(extensions)
      for (let i = 0; i < list.length; i++) {
        let ext = list[i]
        if (typeof ext !== 'string') {
          throw new TypeError('option extensions must be array of strings or false')
        }
        if (!/^\./.exec(ext)) ext = '.' + ext
        if (await fs.exists(path + ext)) {
          path = path + ext
          break
        }
      }
    }
  }

  let encodingExt = ''
  // serve brotli file when possible otherwise gzipped file when possible
  if (brotli && ctx.acceptsEncodings('br', 'identity') === 'br' && (await fs.exists(path + '.br'))) {
    path = path + '.br'
    ctx.set('Content-Encoding', 'br')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.br'
  } else if (gzip && ctx.acceptsEncodings('gzip', 'identity') === 'gzip' && (await fs.exists(path + '.gz'))) {
    path = path + '.gz'
    ctx.set('Content-Encoding', 'gzip')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.gz'
  }

  // stat
  let stats
  try {
    stats = await fs.stat(path)

    // Format the path to serve static file servers
    // and not require a trailing slash for directories,
    // so that you can do both `/directory` and `/directory/`
    if (stats.isDirectory()) {
      if (!format) {
        ctx.redirect(ctx.url + '/')
        return
      } else if (index) {
        path = resolve(path, index)
        stats = await fs.stat(path)
      } else {
        return
      }
    }
  } catch (err) {
    const notfound = ['ENOENT', 'ENAMETOOLONG', 'ENOTDIR']
    if (notfound.includes(err.code)) {
      throw createError(404, err)
    }
    err.status = 500
    throw err
  }

  if (setHeaders) setHeaders(ctx.res, path, stats)

  // stream
  ctx.set('Content-Length', stats.size)
  if (!ctx.response.get('Last-Modified')) ctx.set('Last-Modified', stats.mtime.toUTCString())
  if (!ctx.response.get('Cache-Control')) {
    const directives = ['max-age=' + (maxage / 1000 | 0)]
    if (immutable) {
      directives.push('immutable')
    }
    ctx.set('Cache-Control', directives.join(','))
  }
  ctx.type = type(path, encodingExt)
  ctx.body = fs.createReadStream(path)

  return path
}

/**
 * Check if it's hidden.
 */

function isHidden(root, path) {
  path = path.substr(root.length).split(sep)
  for (let i = 0; i < path.length; i++) {
    if (path[i][0] === '.') return true
  }
  return false
}

/**
 * File type.
 */

function type(file, ext) {
  return ext !== '' ? extname(basename(file, ext)) : extname(file)
}

/**
 * Decode `path`.
 */

function decode(path) {
  return decodeURIComponent(path)
}
