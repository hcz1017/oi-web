(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/wasi_defs.js
  var wasi_defs_exports = {};
  __export(wasi_defs_exports, {
    ADVICE_DONTNEED: () => ADVICE_DONTNEED,
    ADVICE_NOREUSE: () => ADVICE_NOREUSE,
    ADVICE_NORMAL: () => ADVICE_NORMAL,
    ADVICE_RANDOM: () => ADVICE_RANDOM,
    ADVICE_SEQUENTIAL: () => ADVICE_SEQUENTIAL,
    ADVICE_WILLNEED: () => ADVICE_WILLNEED,
    CLOCKID_MONOTONIC: () => CLOCKID_MONOTONIC,
    CLOCKID_PROCESS_CPUTIME_ID: () => CLOCKID_PROCESS_CPUTIME_ID,
    CLOCKID_REALTIME: () => CLOCKID_REALTIME,
    CLOCKID_THREAD_CPUTIME_ID: () => CLOCKID_THREAD_CPUTIME_ID,
    Ciovec: () => Ciovec,
    Dirent: () => Dirent,
    ERRNO_2BIG: () => ERRNO_2BIG,
    ERRNO_ACCES: () => ERRNO_ACCES,
    ERRNO_ADDRINUSE: () => ERRNO_ADDRINUSE,
    ERRNO_ADDRNOTAVAIL: () => ERRNO_ADDRNOTAVAIL,
    ERRNO_AFNOSUPPORT: () => ERRNO_AFNOSUPPORT,
    ERRNO_AGAIN: () => ERRNO_AGAIN,
    ERRNO_ALREADY: () => ERRNO_ALREADY,
    ERRNO_BADF: () => ERRNO_BADF,
    ERRNO_BADMSG: () => ERRNO_BADMSG,
    ERRNO_BUSY: () => ERRNO_BUSY,
    ERRNO_CANCELED: () => ERRNO_CANCELED,
    ERRNO_CHILD: () => ERRNO_CHILD,
    ERRNO_CONNABORTED: () => ERRNO_CONNABORTED,
    ERRNO_CONNREFUSED: () => ERRNO_CONNREFUSED,
    ERRNO_CONNRESET: () => ERRNO_CONNRESET,
    ERRNO_DEADLK: () => ERRNO_DEADLK,
    ERRNO_DESTADDRREQ: () => ERRNO_DESTADDRREQ,
    ERRNO_DOM: () => ERRNO_DOM,
    ERRNO_DQUOT: () => ERRNO_DQUOT,
    ERRNO_EXIST: () => ERRNO_EXIST,
    ERRNO_FAULT: () => ERRNO_FAULT,
    ERRNO_FBIG: () => ERRNO_FBIG,
    ERRNO_HOSTUNREACH: () => ERRNO_HOSTUNREACH,
    ERRNO_IDRM: () => ERRNO_IDRM,
    ERRNO_ILSEQ: () => ERRNO_ILSEQ,
    ERRNO_INPROGRESS: () => ERRNO_INPROGRESS,
    ERRNO_INTR: () => ERRNO_INTR,
    ERRNO_INVAL: () => ERRNO_INVAL,
    ERRNO_IO: () => ERRNO_IO,
    ERRNO_ISCONN: () => ERRNO_ISCONN,
    ERRNO_ISDIR: () => ERRNO_ISDIR,
    ERRNO_LOOP: () => ERRNO_LOOP,
    ERRNO_MFILE: () => ERRNO_MFILE,
    ERRNO_MLINK: () => ERRNO_MLINK,
    ERRNO_MSGSIZE: () => ERRNO_MSGSIZE,
    ERRNO_MULTIHOP: () => ERRNO_MULTIHOP,
    ERRNO_NAMETOOLONG: () => ERRNO_NAMETOOLONG,
    ERRNO_NETDOWN: () => ERRNO_NETDOWN,
    ERRNO_NETRESET: () => ERRNO_NETRESET,
    ERRNO_NETUNREACH: () => ERRNO_NETUNREACH,
    ERRNO_NFILE: () => ERRNO_NFILE,
    ERRNO_NOBUFS: () => ERRNO_NOBUFS,
    ERRNO_NODEV: () => ERRNO_NODEV,
    ERRNO_NOENT: () => ERRNO_NOENT,
    ERRNO_NOEXEC: () => ERRNO_NOEXEC,
    ERRNO_NOLCK: () => ERRNO_NOLCK,
    ERRNO_NOLINK: () => ERRNO_NOLINK,
    ERRNO_NOMEM: () => ERRNO_NOMEM,
    ERRNO_NOMSG: () => ERRNO_NOMSG,
    ERRNO_NOPROTOOPT: () => ERRNO_NOPROTOOPT,
    ERRNO_NOSPC: () => ERRNO_NOSPC,
    ERRNO_NOSYS: () => ERRNO_NOSYS,
    ERRNO_NOTCAPABLE: () => ERRNO_NOTCAPABLE,
    ERRNO_NOTCONN: () => ERRNO_NOTCONN,
    ERRNO_NOTDIR: () => ERRNO_NOTDIR,
    ERRNO_NOTEMPTY: () => ERRNO_NOTEMPTY,
    ERRNO_NOTRECOVERABLE: () => ERRNO_NOTRECOVERABLE,
    ERRNO_NOTSOCK: () => ERRNO_NOTSOCK,
    ERRNO_NOTSUP: () => ERRNO_NOTSUP,
    ERRNO_NOTTY: () => ERRNO_NOTTY,
    ERRNO_NXIO: () => ERRNO_NXIO,
    ERRNO_OVERFLOW: () => ERRNO_OVERFLOW,
    ERRNO_OWNERDEAD: () => ERRNO_OWNERDEAD,
    ERRNO_PERM: () => ERRNO_PERM,
    ERRNO_PIPE: () => ERRNO_PIPE,
    ERRNO_PROTO: () => ERRNO_PROTO,
    ERRNO_PROTONOSUPPORT: () => ERRNO_PROTONOSUPPORT,
    ERRNO_PROTOTYPE: () => ERRNO_PROTOTYPE,
    ERRNO_RANGE: () => ERRNO_RANGE,
    ERRNO_ROFS: () => ERRNO_ROFS,
    ERRNO_SPIPE: () => ERRNO_SPIPE,
    ERRNO_SRCH: () => ERRNO_SRCH,
    ERRNO_STALE: () => ERRNO_STALE,
    ERRNO_SUCCESS: () => ERRNO_SUCCESS,
    ERRNO_TIMEDOUT: () => ERRNO_TIMEDOUT,
    ERRNO_TXTBSY: () => ERRNO_TXTBSY,
    ERRNO_XDEV: () => ERRNO_XDEV,
    EVENTRWFLAGS_FD_READWRITE_HANGUP: () => EVENTRWFLAGS_FD_READWRITE_HANGUP,
    EVENTTYPE_CLOCK: () => EVENTTYPE_CLOCK,
    EVENTTYPE_FD_READ: () => EVENTTYPE_FD_READ,
    EVENTTYPE_FD_WRITE: () => EVENTTYPE_FD_WRITE,
    Event: () => Event,
    FDFLAGS_APPEND: () => FDFLAGS_APPEND,
    FDFLAGS_DSYNC: () => FDFLAGS_DSYNC,
    FDFLAGS_NONBLOCK: () => FDFLAGS_NONBLOCK,
    FDFLAGS_RSYNC: () => FDFLAGS_RSYNC,
    FDFLAGS_SYNC: () => FDFLAGS_SYNC,
    FD_STDERR: () => FD_STDERR,
    FD_STDIN: () => FD_STDIN,
    FD_STDOUT: () => FD_STDOUT,
    FILETYPE_BLOCK_DEVICE: () => FILETYPE_BLOCK_DEVICE,
    FILETYPE_CHARACTER_DEVICE: () => FILETYPE_CHARACTER_DEVICE,
    FILETYPE_DIRECTORY: () => FILETYPE_DIRECTORY,
    FILETYPE_REGULAR_FILE: () => FILETYPE_REGULAR_FILE,
    FILETYPE_SOCKET_DGRAM: () => FILETYPE_SOCKET_DGRAM,
    FILETYPE_SOCKET_STREAM: () => FILETYPE_SOCKET_STREAM,
    FILETYPE_SYMBOLIC_LINK: () => FILETYPE_SYMBOLIC_LINK,
    FILETYPE_UNKNOWN: () => FILETYPE_UNKNOWN,
    FSTFLAGS_ATIM: () => FSTFLAGS_ATIM,
    FSTFLAGS_ATIM_NOW: () => FSTFLAGS_ATIM_NOW,
    FSTFLAGS_MTIM: () => FSTFLAGS_MTIM,
    FSTFLAGS_MTIM_NOW: () => FSTFLAGS_MTIM_NOW,
    Fdstat: () => Fdstat,
    Filestat: () => Filestat,
    Iovec: () => Iovec,
    OFLAGS_CREAT: () => OFLAGS_CREAT,
    OFLAGS_DIRECTORY: () => OFLAGS_DIRECTORY,
    OFLAGS_EXCL: () => OFLAGS_EXCL,
    OFLAGS_TRUNC: () => OFLAGS_TRUNC,
    PREOPENTYPE_DIR: () => PREOPENTYPE_DIR,
    Prestat: () => Prestat,
    PrestatDir: () => PrestatDir,
    RIFLAGS_RECV_PEEK: () => RIFLAGS_RECV_PEEK,
    RIFLAGS_RECV_WAITALL: () => RIFLAGS_RECV_WAITALL,
    RIGHTS_FD_ADVISE: () => RIGHTS_FD_ADVISE,
    RIGHTS_FD_ALLOCATE: () => RIGHTS_FD_ALLOCATE,
    RIGHTS_FD_DATASYNC: () => RIGHTS_FD_DATASYNC,
    RIGHTS_FD_FDSTAT_SET_FLAGS: () => RIGHTS_FD_FDSTAT_SET_FLAGS,
    RIGHTS_FD_FILESTAT_GET: () => RIGHTS_FD_FILESTAT_GET,
    RIGHTS_FD_FILESTAT_SET_SIZE: () => RIGHTS_FD_FILESTAT_SET_SIZE,
    RIGHTS_FD_FILESTAT_SET_TIMES: () => RIGHTS_FD_FILESTAT_SET_TIMES,
    RIGHTS_FD_READ: () => RIGHTS_FD_READ,
    RIGHTS_FD_READDIR: () => RIGHTS_FD_READDIR,
    RIGHTS_FD_SEEK: () => RIGHTS_FD_SEEK,
    RIGHTS_FD_SYNC: () => RIGHTS_FD_SYNC,
    RIGHTS_FD_TELL: () => RIGHTS_FD_TELL,
    RIGHTS_FD_WRITE: () => RIGHTS_FD_WRITE,
    RIGHTS_PATH_CREATE_DIRECTORY: () => RIGHTS_PATH_CREATE_DIRECTORY,
    RIGHTS_PATH_CREATE_FILE: () => RIGHTS_PATH_CREATE_FILE,
    RIGHTS_PATH_FILESTAT_GET: () => RIGHTS_PATH_FILESTAT_GET,
    RIGHTS_PATH_FILESTAT_SET_SIZE: () => RIGHTS_PATH_FILESTAT_SET_SIZE,
    RIGHTS_PATH_FILESTAT_SET_TIMES: () => RIGHTS_PATH_FILESTAT_SET_TIMES,
    RIGHTS_PATH_LINK_SOURCE: () => RIGHTS_PATH_LINK_SOURCE,
    RIGHTS_PATH_LINK_TARGET: () => RIGHTS_PATH_LINK_TARGET,
    RIGHTS_PATH_OPEN: () => RIGHTS_PATH_OPEN,
    RIGHTS_PATH_READLINK: () => RIGHTS_PATH_READLINK,
    RIGHTS_PATH_REMOVE_DIRECTORY: () => RIGHTS_PATH_REMOVE_DIRECTORY,
    RIGHTS_PATH_RENAME_SOURCE: () => RIGHTS_PATH_RENAME_SOURCE,
    RIGHTS_PATH_RENAME_TARGET: () => RIGHTS_PATH_RENAME_TARGET,
    RIGHTS_PATH_SYMLINK: () => RIGHTS_PATH_SYMLINK,
    RIGHTS_PATH_UNLINK_FILE: () => RIGHTS_PATH_UNLINK_FILE,
    RIGHTS_POLL_FD_READWRITE: () => RIGHTS_POLL_FD_READWRITE,
    RIGHTS_SOCK_SHUTDOWN: () => RIGHTS_SOCK_SHUTDOWN,
    ROFLAGS_RECV_DATA_TRUNCATED: () => ROFLAGS_RECV_DATA_TRUNCATED,
    SDFLAGS_RD: () => SDFLAGS_RD,
    SDFLAGS_WR: () => SDFLAGS_WR,
    SIGNAL_ABRT: () => SIGNAL_ABRT,
    SIGNAL_ALRM: () => SIGNAL_ALRM,
    SIGNAL_BUS: () => SIGNAL_BUS,
    SIGNAL_CHLD: () => SIGNAL_CHLD,
    SIGNAL_CONT: () => SIGNAL_CONT,
    SIGNAL_FPE: () => SIGNAL_FPE,
    SIGNAL_HUP: () => SIGNAL_HUP,
    SIGNAL_ILL: () => SIGNAL_ILL,
    SIGNAL_INT: () => SIGNAL_INT,
    SIGNAL_KILL: () => SIGNAL_KILL,
    SIGNAL_NONE: () => SIGNAL_NONE,
    SIGNAL_PIPE: () => SIGNAL_PIPE,
    SIGNAL_POLL: () => SIGNAL_POLL,
    SIGNAL_PROF: () => SIGNAL_PROF,
    SIGNAL_PWR: () => SIGNAL_PWR,
    SIGNAL_QUIT: () => SIGNAL_QUIT,
    SIGNAL_SEGV: () => SIGNAL_SEGV,
    SIGNAL_STOP: () => SIGNAL_STOP,
    SIGNAL_SYS: () => SIGNAL_SYS,
    SIGNAL_TERM: () => SIGNAL_TERM,
    SIGNAL_TRAP: () => SIGNAL_TRAP,
    SIGNAL_TSTP: () => SIGNAL_TSTP,
    SIGNAL_TTIN: () => SIGNAL_TTIN,
    SIGNAL_TTOU: () => SIGNAL_TTOU,
    SIGNAL_URG: () => SIGNAL_URG,
    SIGNAL_USR1: () => SIGNAL_USR1,
    SIGNAL_USR2: () => SIGNAL_USR2,
    SIGNAL_VTALRM: () => SIGNAL_VTALRM,
    SIGNAL_WINCH: () => SIGNAL_WINCH,
    SIGNAL_XCPU: () => SIGNAL_XCPU,
    SIGNAL_XFSZ: () => SIGNAL_XFSZ,
    SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME: () => SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME,
    Subscription: () => Subscription,
    WHENCE_CUR: () => WHENCE_CUR,
    WHENCE_END: () => WHENCE_END,
    WHENCE_SET: () => WHENCE_SET
  });
  var FD_STDIN, FD_STDOUT, FD_STDERR, CLOCKID_REALTIME, CLOCKID_MONOTONIC, CLOCKID_PROCESS_CPUTIME_ID, CLOCKID_THREAD_CPUTIME_ID, ERRNO_SUCCESS, ERRNO_2BIG, ERRNO_ACCES, ERRNO_ADDRINUSE, ERRNO_ADDRNOTAVAIL, ERRNO_AFNOSUPPORT, ERRNO_AGAIN, ERRNO_ALREADY, ERRNO_BADF, ERRNO_BADMSG, ERRNO_BUSY, ERRNO_CANCELED, ERRNO_CHILD, ERRNO_CONNABORTED, ERRNO_CONNREFUSED, ERRNO_CONNRESET, ERRNO_DEADLK, ERRNO_DESTADDRREQ, ERRNO_DOM, ERRNO_DQUOT, ERRNO_EXIST, ERRNO_FAULT, ERRNO_FBIG, ERRNO_HOSTUNREACH, ERRNO_IDRM, ERRNO_ILSEQ, ERRNO_INPROGRESS, ERRNO_INTR, ERRNO_INVAL, ERRNO_IO, ERRNO_ISCONN, ERRNO_ISDIR, ERRNO_LOOP, ERRNO_MFILE, ERRNO_MLINK, ERRNO_MSGSIZE, ERRNO_MULTIHOP, ERRNO_NAMETOOLONG, ERRNO_NETDOWN, ERRNO_NETRESET, ERRNO_NETUNREACH, ERRNO_NFILE, ERRNO_NOBUFS, ERRNO_NODEV, ERRNO_NOENT, ERRNO_NOEXEC, ERRNO_NOLCK, ERRNO_NOLINK, ERRNO_NOMEM, ERRNO_NOMSG, ERRNO_NOPROTOOPT, ERRNO_NOSPC, ERRNO_NOSYS, ERRNO_NOTCONN, ERRNO_NOTDIR, ERRNO_NOTEMPTY, ERRNO_NOTRECOVERABLE, ERRNO_NOTSOCK, ERRNO_NOTSUP, ERRNO_NOTTY, ERRNO_NXIO, ERRNO_OVERFLOW, ERRNO_OWNERDEAD, ERRNO_PERM, ERRNO_PIPE, ERRNO_PROTO, ERRNO_PROTONOSUPPORT, ERRNO_PROTOTYPE, ERRNO_RANGE, ERRNO_ROFS, ERRNO_SPIPE, ERRNO_SRCH, ERRNO_STALE, ERRNO_TIMEDOUT, ERRNO_TXTBSY, ERRNO_XDEV, ERRNO_NOTCAPABLE, RIGHTS_FD_DATASYNC, RIGHTS_FD_READ, RIGHTS_FD_SEEK, RIGHTS_FD_FDSTAT_SET_FLAGS, RIGHTS_FD_SYNC, RIGHTS_FD_TELL, RIGHTS_FD_WRITE, RIGHTS_FD_ADVISE, RIGHTS_FD_ALLOCATE, RIGHTS_PATH_CREATE_DIRECTORY, RIGHTS_PATH_CREATE_FILE, RIGHTS_PATH_LINK_SOURCE, RIGHTS_PATH_LINK_TARGET, RIGHTS_PATH_OPEN, RIGHTS_FD_READDIR, RIGHTS_PATH_READLINK, RIGHTS_PATH_RENAME_SOURCE, RIGHTS_PATH_RENAME_TARGET, RIGHTS_PATH_FILESTAT_GET, RIGHTS_PATH_FILESTAT_SET_SIZE, RIGHTS_PATH_FILESTAT_SET_TIMES, RIGHTS_FD_FILESTAT_GET, RIGHTS_FD_FILESTAT_SET_SIZE, RIGHTS_FD_FILESTAT_SET_TIMES, RIGHTS_PATH_SYMLINK, RIGHTS_PATH_REMOVE_DIRECTORY, RIGHTS_PATH_UNLINK_FILE, RIGHTS_POLL_FD_READWRITE, RIGHTS_SOCK_SHUTDOWN, Iovec, Ciovec, WHENCE_SET, WHENCE_CUR, WHENCE_END, FILETYPE_UNKNOWN, FILETYPE_BLOCK_DEVICE, FILETYPE_CHARACTER_DEVICE, FILETYPE_DIRECTORY, FILETYPE_REGULAR_FILE, FILETYPE_SOCKET_DGRAM, FILETYPE_SOCKET_STREAM, FILETYPE_SYMBOLIC_LINK, Dirent, ADVICE_NORMAL, ADVICE_SEQUENTIAL, ADVICE_RANDOM, ADVICE_WILLNEED, ADVICE_DONTNEED, ADVICE_NOREUSE, FDFLAGS_APPEND, FDFLAGS_DSYNC, FDFLAGS_NONBLOCK, FDFLAGS_RSYNC, FDFLAGS_SYNC, Fdstat, FSTFLAGS_ATIM, FSTFLAGS_ATIM_NOW, FSTFLAGS_MTIM, FSTFLAGS_MTIM_NOW, OFLAGS_CREAT, OFLAGS_DIRECTORY, OFLAGS_EXCL, OFLAGS_TRUNC, Filestat, EVENTTYPE_CLOCK, EVENTTYPE_FD_READ, EVENTTYPE_FD_WRITE, EVENTRWFLAGS_FD_READWRITE_HANGUP, SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME, Subscription, Event, SIGNAL_NONE, SIGNAL_HUP, SIGNAL_INT, SIGNAL_QUIT, SIGNAL_ILL, SIGNAL_TRAP, SIGNAL_ABRT, SIGNAL_BUS, SIGNAL_FPE, SIGNAL_KILL, SIGNAL_USR1, SIGNAL_SEGV, SIGNAL_USR2, SIGNAL_PIPE, SIGNAL_ALRM, SIGNAL_TERM, SIGNAL_CHLD, SIGNAL_CONT, SIGNAL_STOP, SIGNAL_TSTP, SIGNAL_TTIN, SIGNAL_TTOU, SIGNAL_URG, SIGNAL_XCPU, SIGNAL_XFSZ, SIGNAL_VTALRM, SIGNAL_PROF, SIGNAL_WINCH, SIGNAL_POLL, SIGNAL_PWR, SIGNAL_SYS, RIFLAGS_RECV_PEEK, RIFLAGS_RECV_WAITALL, ROFLAGS_RECV_DATA_TRUNCATED, SDFLAGS_RD, SDFLAGS_WR, PREOPENTYPE_DIR, PrestatDir, Prestat;
  var init_wasi_defs = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/wasi_defs.js"() {
      FD_STDIN = 0;
      FD_STDOUT = 1;
      FD_STDERR = 2;
      CLOCKID_REALTIME = 0;
      CLOCKID_MONOTONIC = 1;
      CLOCKID_PROCESS_CPUTIME_ID = 2;
      CLOCKID_THREAD_CPUTIME_ID = 3;
      ERRNO_SUCCESS = 0;
      ERRNO_2BIG = 1;
      ERRNO_ACCES = 2;
      ERRNO_ADDRINUSE = 3;
      ERRNO_ADDRNOTAVAIL = 4;
      ERRNO_AFNOSUPPORT = 5;
      ERRNO_AGAIN = 6;
      ERRNO_ALREADY = 7;
      ERRNO_BADF = 8;
      ERRNO_BADMSG = 9;
      ERRNO_BUSY = 10;
      ERRNO_CANCELED = 11;
      ERRNO_CHILD = 12;
      ERRNO_CONNABORTED = 13;
      ERRNO_CONNREFUSED = 14;
      ERRNO_CONNRESET = 15;
      ERRNO_DEADLK = 16;
      ERRNO_DESTADDRREQ = 17;
      ERRNO_DOM = 18;
      ERRNO_DQUOT = 19;
      ERRNO_EXIST = 20;
      ERRNO_FAULT = 21;
      ERRNO_FBIG = 22;
      ERRNO_HOSTUNREACH = 23;
      ERRNO_IDRM = 24;
      ERRNO_ILSEQ = 25;
      ERRNO_INPROGRESS = 26;
      ERRNO_INTR = 27;
      ERRNO_INVAL = 28;
      ERRNO_IO = 29;
      ERRNO_ISCONN = 30;
      ERRNO_ISDIR = 31;
      ERRNO_LOOP = 32;
      ERRNO_MFILE = 33;
      ERRNO_MLINK = 34;
      ERRNO_MSGSIZE = 35;
      ERRNO_MULTIHOP = 36;
      ERRNO_NAMETOOLONG = 37;
      ERRNO_NETDOWN = 38;
      ERRNO_NETRESET = 39;
      ERRNO_NETUNREACH = 40;
      ERRNO_NFILE = 41;
      ERRNO_NOBUFS = 42;
      ERRNO_NODEV = 43;
      ERRNO_NOENT = 44;
      ERRNO_NOEXEC = 45;
      ERRNO_NOLCK = 46;
      ERRNO_NOLINK = 47;
      ERRNO_NOMEM = 48;
      ERRNO_NOMSG = 49;
      ERRNO_NOPROTOOPT = 50;
      ERRNO_NOSPC = 51;
      ERRNO_NOSYS = 52;
      ERRNO_NOTCONN = 53;
      ERRNO_NOTDIR = 54;
      ERRNO_NOTEMPTY = 55;
      ERRNO_NOTRECOVERABLE = 56;
      ERRNO_NOTSOCK = 57;
      ERRNO_NOTSUP = 58;
      ERRNO_NOTTY = 59;
      ERRNO_NXIO = 60;
      ERRNO_OVERFLOW = 61;
      ERRNO_OWNERDEAD = 62;
      ERRNO_PERM = 63;
      ERRNO_PIPE = 64;
      ERRNO_PROTO = 65;
      ERRNO_PROTONOSUPPORT = 66;
      ERRNO_PROTOTYPE = 67;
      ERRNO_RANGE = 68;
      ERRNO_ROFS = 69;
      ERRNO_SPIPE = 70;
      ERRNO_SRCH = 71;
      ERRNO_STALE = 72;
      ERRNO_TIMEDOUT = 73;
      ERRNO_TXTBSY = 74;
      ERRNO_XDEV = 75;
      ERRNO_NOTCAPABLE = 76;
      RIGHTS_FD_DATASYNC = 1 << 0;
      RIGHTS_FD_READ = 1 << 1;
      RIGHTS_FD_SEEK = 1 << 2;
      RIGHTS_FD_FDSTAT_SET_FLAGS = 1 << 3;
      RIGHTS_FD_SYNC = 1 << 4;
      RIGHTS_FD_TELL = 1 << 5;
      RIGHTS_FD_WRITE = 1 << 6;
      RIGHTS_FD_ADVISE = 1 << 7;
      RIGHTS_FD_ALLOCATE = 1 << 8;
      RIGHTS_PATH_CREATE_DIRECTORY = 1 << 9;
      RIGHTS_PATH_CREATE_FILE = 1 << 10;
      RIGHTS_PATH_LINK_SOURCE = 1 << 11;
      RIGHTS_PATH_LINK_TARGET = 1 << 12;
      RIGHTS_PATH_OPEN = 1 << 13;
      RIGHTS_FD_READDIR = 1 << 14;
      RIGHTS_PATH_READLINK = 1 << 15;
      RIGHTS_PATH_RENAME_SOURCE = 1 << 16;
      RIGHTS_PATH_RENAME_TARGET = 1 << 17;
      RIGHTS_PATH_FILESTAT_GET = 1 << 18;
      RIGHTS_PATH_FILESTAT_SET_SIZE = 1 << 19;
      RIGHTS_PATH_FILESTAT_SET_TIMES = 1 << 20;
      RIGHTS_FD_FILESTAT_GET = 1 << 21;
      RIGHTS_FD_FILESTAT_SET_SIZE = 1 << 22;
      RIGHTS_FD_FILESTAT_SET_TIMES = 1 << 23;
      RIGHTS_PATH_SYMLINK = 1 << 24;
      RIGHTS_PATH_REMOVE_DIRECTORY = 1 << 25;
      RIGHTS_PATH_UNLINK_FILE = 1 << 26;
      RIGHTS_POLL_FD_READWRITE = 1 << 27;
      RIGHTS_SOCK_SHUTDOWN = 1 << 28;
      Iovec = class _Iovec {
        static read_bytes(view, ptr) {
          const iovec = new _Iovec();
          iovec.buf = view.getUint32(ptr, true);
          iovec.buf_len = view.getUint32(ptr + 4, true);
          return iovec;
        }
        static read_bytes_array(view, ptr, len) {
          const iovecs = [];
          for (let i = 0; i < len; i++) {
            iovecs.push(_Iovec.read_bytes(view, ptr + 8 * i));
          }
          return iovecs;
        }
      };
      Ciovec = class _Ciovec {
        static read_bytes(view, ptr) {
          const iovec = new _Ciovec();
          iovec.buf = view.getUint32(ptr, true);
          iovec.buf_len = view.getUint32(ptr + 4, true);
          return iovec;
        }
        static read_bytes_array(view, ptr, len) {
          const iovecs = [];
          for (let i = 0; i < len; i++) {
            iovecs.push(_Ciovec.read_bytes(view, ptr + 8 * i));
          }
          return iovecs;
        }
      };
      WHENCE_SET = 0;
      WHENCE_CUR = 1;
      WHENCE_END = 2;
      FILETYPE_UNKNOWN = 0;
      FILETYPE_BLOCK_DEVICE = 1;
      FILETYPE_CHARACTER_DEVICE = 2;
      FILETYPE_DIRECTORY = 3;
      FILETYPE_REGULAR_FILE = 4;
      FILETYPE_SOCKET_DGRAM = 5;
      FILETYPE_SOCKET_STREAM = 6;
      FILETYPE_SYMBOLIC_LINK = 7;
      Dirent = class {
        head_length() {
          return 24;
        }
        name_length() {
          return this.dir_name.byteLength;
        }
        write_head_bytes(view, ptr) {
          view.setBigUint64(ptr, this.d_next, true);
          view.setBigUint64(ptr + 8, this.d_ino, true);
          view.setUint32(ptr + 16, this.dir_name.length, true);
          view.setUint8(ptr + 20, this.d_type);
        }
        write_name_bytes(view8, ptr, buf_len) {
          view8.set(this.dir_name.slice(0, Math.min(this.dir_name.byteLength, buf_len)), ptr);
        }
        constructor(next_cookie, d_ino, name, type) {
          const encoded_name = new TextEncoder().encode(name);
          this.d_next = next_cookie;
          this.d_ino = d_ino;
          this.d_namlen = encoded_name.byteLength;
          this.d_type = type;
          this.dir_name = encoded_name;
        }
      };
      ADVICE_NORMAL = 0;
      ADVICE_SEQUENTIAL = 1;
      ADVICE_RANDOM = 2;
      ADVICE_WILLNEED = 3;
      ADVICE_DONTNEED = 4;
      ADVICE_NOREUSE = 5;
      FDFLAGS_APPEND = 1 << 0;
      FDFLAGS_DSYNC = 1 << 1;
      FDFLAGS_NONBLOCK = 1 << 2;
      FDFLAGS_RSYNC = 1 << 3;
      FDFLAGS_SYNC = 1 << 4;
      Fdstat = class {
        write_bytes(view, ptr) {
          view.setUint8(ptr, this.fs_filetype);
          view.setUint16(ptr + 2, this.fs_flags, true);
          view.setBigUint64(ptr + 8, this.fs_rights_base, true);
          view.setBigUint64(ptr + 16, this.fs_rights_inherited, true);
        }
        constructor(filetype, flags) {
          this.fs_rights_base = 0n;
          this.fs_rights_inherited = 0n;
          this.fs_filetype = filetype;
          this.fs_flags = flags;
        }
      };
      FSTFLAGS_ATIM = 1 << 0;
      FSTFLAGS_ATIM_NOW = 1 << 1;
      FSTFLAGS_MTIM = 1 << 2;
      FSTFLAGS_MTIM_NOW = 1 << 3;
      OFLAGS_CREAT = 1 << 0;
      OFLAGS_DIRECTORY = 1 << 1;
      OFLAGS_EXCL = 1 << 2;
      OFLAGS_TRUNC = 1 << 3;
      Filestat = class {
        write_bytes(view, ptr) {
          view.setBigUint64(ptr, this.dev, true);
          view.setBigUint64(ptr + 8, this.ino, true);
          view.setUint8(ptr + 16, this.filetype);
          view.setBigUint64(ptr + 24, this.nlink, true);
          view.setBigUint64(ptr + 32, this.size, true);
          view.setBigUint64(ptr + 38, this.atim, true);
          view.setBigUint64(ptr + 46, this.mtim, true);
          view.setBigUint64(ptr + 52, this.ctim, true);
        }
        constructor(ino, filetype, size) {
          this.dev = 0n;
          this.nlink = 0n;
          this.atim = 0n;
          this.mtim = 0n;
          this.ctim = 0n;
          this.ino = ino;
          this.filetype = filetype;
          this.size = size;
        }
      };
      EVENTTYPE_CLOCK = 0;
      EVENTTYPE_FD_READ = 1;
      EVENTTYPE_FD_WRITE = 2;
      EVENTRWFLAGS_FD_READWRITE_HANGUP = 1 << 0;
      SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME = 1 << 0;
      Subscription = class _Subscription {
        static read_bytes(view, ptr) {
          return new _Subscription(view.getBigUint64(ptr, true), view.getUint8(ptr + 8), view.getUint32(ptr + 16, true), view.getBigUint64(ptr + 24, true), view.getUint16(ptr + 36, true));
        }
        constructor(userdata, eventtype, clockid, timeout, flags) {
          this.userdata = userdata;
          this.eventtype = eventtype;
          this.clockid = clockid;
          this.timeout = timeout;
          this.flags = flags;
        }
      };
      Event = class {
        write_bytes(view, ptr) {
          view.setBigUint64(ptr, this.userdata, true);
          view.setUint16(ptr + 8, this.error, true);
          view.setUint8(ptr + 10, this.eventtype);
        }
        constructor(userdata, error, eventtype) {
          this.userdata = userdata;
          this.error = error;
          this.eventtype = eventtype;
        }
      };
      SIGNAL_NONE = 0;
      SIGNAL_HUP = 1;
      SIGNAL_INT = 2;
      SIGNAL_QUIT = 3;
      SIGNAL_ILL = 4;
      SIGNAL_TRAP = 5;
      SIGNAL_ABRT = 6;
      SIGNAL_BUS = 7;
      SIGNAL_FPE = 8;
      SIGNAL_KILL = 9;
      SIGNAL_USR1 = 10;
      SIGNAL_SEGV = 11;
      SIGNAL_USR2 = 12;
      SIGNAL_PIPE = 13;
      SIGNAL_ALRM = 14;
      SIGNAL_TERM = 15;
      SIGNAL_CHLD = 16;
      SIGNAL_CONT = 17;
      SIGNAL_STOP = 18;
      SIGNAL_TSTP = 19;
      SIGNAL_TTIN = 20;
      SIGNAL_TTOU = 21;
      SIGNAL_URG = 22;
      SIGNAL_XCPU = 23;
      SIGNAL_XFSZ = 24;
      SIGNAL_VTALRM = 25;
      SIGNAL_PROF = 26;
      SIGNAL_WINCH = 27;
      SIGNAL_POLL = 28;
      SIGNAL_PWR = 29;
      SIGNAL_SYS = 30;
      RIFLAGS_RECV_PEEK = 1 << 0;
      RIFLAGS_RECV_WAITALL = 1 << 1;
      ROFLAGS_RECV_DATA_TRUNCATED = 1 << 0;
      SDFLAGS_RD = 1 << 0;
      SDFLAGS_WR = 1 << 1;
      PREOPENTYPE_DIR = 0;
      PrestatDir = class {
        write_bytes(view, ptr) {
          view.setUint32(ptr, this.pr_name.byteLength, true);
        }
        constructor(name) {
          this.pr_name = new TextEncoder().encode(name);
        }
      };
      Prestat = class _Prestat {
        static dir(name) {
          const prestat = new _Prestat();
          prestat.tag = PREOPENTYPE_DIR;
          prestat.inner = new PrestatDir(name);
          return prestat;
        }
        write_bytes(view, ptr) {
          view.setUint32(ptr, this.tag, true);
          this.inner.write_bytes(view, ptr + 4);
        }
      };
    }
  });

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/debug.js
  function createLogger(enabled, prefix) {
    if (enabled) {
      const a = (() => {
      }).bind(console, "%c%s", "color: #265BA0", prefix);
      return a;
    } else {
      return () => {
      };
    }
  }
  var Debug, debug;
  var init_debug = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/debug.js"() {
      Debug = class Debug2 {
        enable(enabled) {
          this.log = createLogger(enabled === void 0 ? true : enabled, this.prefix);
        }
        get enabled() {
          return this.isEnabled;
        }
        constructor(isEnabled) {
          this.isEnabled = isEnabled;
          this.prefix = "wasi:";
          this.enable(isEnabled);
        }
      };
      debug = new Debug(false);
    }
  });

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/wasi.js
  var WASIProcExit, WASI;
  var init_wasi = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/wasi.js"() {
      init_wasi_defs();
      init_debug();
      WASIProcExit = class extends Error {
        constructor(code) {
          super("exit with exit code " + code);
          this.code = code;
        }
      };
      WASI = class WASI2 {
        start(instance) {
          this.inst = instance;
          try {
            instance.exports._start();
            return 0;
          } catch (e) {
            if (e instanceof WASIProcExit) {
              return e.code;
            } else {
              throw e;
            }
          }
        }
        initialize(instance) {
          this.inst = instance;
          if (instance.exports._initialize) {
            instance.exports._initialize();
          }
        }
        constructor(args, env, fds, options = {}) {
          this.args = [];
          this.env = [];
          this.fds = [];
          debug.enable(options.debug);
          this.args = args;
          this.env = env;
          this.fds = fds;
          const self2 = this;
          this.wasiImport = { args_sizes_get(argc, argv_buf_size) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            buffer.setUint32(argc, self2.args.length, true);
            let buf_size = 0;
            for (const arg of self2.args) {
              buf_size += arg.length + 1;
            }
            buffer.setUint32(argv_buf_size, buf_size, true);
            debug.log(buffer.getUint32(argc, true), buffer.getUint32(argv_buf_size, true));
            return 0;
          }, args_get(argv, argv_buf) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            const orig_argv_buf = argv_buf;
            for (let i = 0; i < self2.args.length; i++) {
              buffer.setUint32(argv, argv_buf, true);
              argv += 4;
              const arg = new TextEncoder().encode(self2.args[i]);
              buffer8.set(arg, argv_buf);
              buffer.setUint8(argv_buf + arg.length, 0);
              argv_buf += arg.length + 1;
            }
            if (debug.enabled) {
              debug.log(new TextDecoder("utf-8").decode(buffer8.slice(orig_argv_buf, argv_buf)));
            }
            return 0;
          }, environ_sizes_get(environ_count, environ_size) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            buffer.setUint32(environ_count, self2.env.length, true);
            let buf_size = 0;
            for (const environ of self2.env) {
              buf_size += new TextEncoder().encode(environ).length + 1;
            }
            buffer.setUint32(environ_size, buf_size, true);
            debug.log(buffer.getUint32(environ_count, true), buffer.getUint32(environ_size, true));
            return 0;
          }, environ_get(environ, environ_buf) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            const orig_environ_buf = environ_buf;
            for (let i = 0; i < self2.env.length; i++) {
              buffer.setUint32(environ, environ_buf, true);
              environ += 4;
              const e = new TextEncoder().encode(self2.env[i]);
              buffer8.set(e, environ_buf);
              buffer.setUint8(environ_buf + e.length, 0);
              environ_buf += e.length + 1;
            }
            if (debug.enabled) {
              debug.log(new TextDecoder("utf-8").decode(buffer8.slice(orig_environ_buf, environ_buf)));
            }
            return 0;
          }, clock_res_get(id, res_ptr) {
            let resolutionValue;
            switch (id) {
              case CLOCKID_MONOTONIC: {
                resolutionValue = 5000n;
                break;
              }
              case CLOCKID_REALTIME: {
                resolutionValue = 1000000n;
                break;
              }
              default:
                return ERRNO_NOSYS;
            }
            const view = new DataView(self2.inst.exports.memory.buffer);
            view.setBigUint64(res_ptr, resolutionValue, true);
            return ERRNO_SUCCESS;
          }, clock_time_get(id, precision, time) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            if (id === CLOCKID_REALTIME) {
              buffer.setBigUint64(time, BigInt((/* @__PURE__ */ new Date()).getTime()) * 1000000n, true);
            } else if (id == CLOCKID_MONOTONIC) {
              let monotonic_time;
              try {
                monotonic_time = BigInt(Math.round(performance.now() * 1e6));
              } catch (e) {
                monotonic_time = 0n;
              }
              buffer.setBigUint64(time, monotonic_time, true);
            } else {
              buffer.setBigUint64(time, 0n, true);
            }
            return 0;
          }, fd_advise(fd, offset, len, advice) {
            if (self2.fds[fd] != void 0) {
              return ERRNO_SUCCESS;
            } else {
              return ERRNO_BADF;
            }
          }, fd_allocate(fd, offset, len) {
            if (self2.fds[fd] != void 0) {
              return self2.fds[fd].fd_allocate(offset, len);
            } else {
              return ERRNO_BADF;
            }
          }, fd_close(fd) {
            if (self2.fds[fd] != void 0) {
              const ret = self2.fds[fd].fd_close();
              self2.fds[fd] = void 0;
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, fd_datasync(fd) {
            if (self2.fds[fd] != void 0) {
              return self2.fds[fd].fd_sync();
            } else {
              return ERRNO_BADF;
            }
          }, fd_fdstat_get(fd, fdstat_ptr) {
            if (self2.fds[fd] != void 0) {
              const { ret, fdstat } = self2.fds[fd].fd_fdstat_get();
              if (fdstat != null) {
                fdstat.write_bytes(new DataView(self2.inst.exports.memory.buffer), fdstat_ptr);
              }
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, fd_fdstat_set_flags(fd, flags) {
            if (self2.fds[fd] != void 0) {
              return self2.fds[fd].fd_fdstat_set_flags(flags);
            } else {
              return ERRNO_BADF;
            }
          }, fd_fdstat_set_rights(fd, fs_rights_base, fs_rights_inheriting) {
            if (self2.fds[fd] != void 0) {
              return self2.fds[fd].fd_fdstat_set_rights(fs_rights_base, fs_rights_inheriting);
            } else {
              return ERRNO_BADF;
            }
          }, fd_filestat_get(fd, filestat_ptr) {
            if (self2.fds[fd] != void 0) {
              const { ret, filestat } = self2.fds[fd].fd_filestat_get();
              if (filestat != null) {
                filestat.write_bytes(new DataView(self2.inst.exports.memory.buffer), filestat_ptr);
              }
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, fd_filestat_set_size(fd, size) {
            if (self2.fds[fd] != void 0) {
              return self2.fds[fd].fd_filestat_set_size(size);
            } else {
              return ERRNO_BADF;
            }
          }, fd_filestat_set_times(fd, atim, mtim, fst_flags) {
            if (self2.fds[fd] != void 0) {
              return self2.fds[fd].fd_filestat_set_times(atim, mtim, fst_flags);
            } else {
              return ERRNO_BADF;
            }
          }, fd_pread(fd, iovs_ptr, iovs_len, offset, nread_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const iovecs = Iovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
              let nread = 0;
              for (const iovec of iovecs) {
                const { ret, data } = self2.fds[fd].fd_pread(iovec.buf_len, offset);
                if (ret != ERRNO_SUCCESS) {
                  buffer.setUint32(nread_ptr, nread, true);
                  return ret;
                }
                buffer8.set(data, iovec.buf);
                nread += data.length;
                offset += BigInt(data.length);
                if (data.length != iovec.buf_len) {
                  break;
                }
              }
              buffer.setUint32(nread_ptr, nread, true);
              return ERRNO_SUCCESS;
            } else {
              return ERRNO_BADF;
            }
          }, fd_prestat_get(fd, buf_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const { ret, prestat } = self2.fds[fd].fd_prestat_get();
              if (prestat != null) {
                prestat.write_bytes(buffer, buf_ptr);
              }
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, fd_prestat_dir_name(fd, path_ptr, path_len) {
            if (self2.fds[fd] != void 0) {
              const { ret, prestat } = self2.fds[fd].fd_prestat_get();
              if (prestat == null) {
                return ret;
              }
              const prestat_dir_name = prestat.inner.pr_name;
              const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
              buffer8.set(prestat_dir_name.slice(0, path_len), path_ptr);
              return prestat_dir_name.byteLength > path_len ? ERRNO_NAMETOOLONG : ERRNO_SUCCESS;
            } else {
              return ERRNO_BADF;
            }
          }, fd_pwrite(fd, iovs_ptr, iovs_len, offset, nwritten_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const iovecs = Ciovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
              let nwritten = 0;
              for (const iovec of iovecs) {
                const data = buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len);
                const { ret, nwritten: nwritten_part } = self2.fds[fd].fd_pwrite(data, offset);
                if (ret != ERRNO_SUCCESS) {
                  buffer.setUint32(nwritten_ptr, nwritten, true);
                  return ret;
                }
                nwritten += nwritten_part;
                offset += BigInt(nwritten_part);
                if (nwritten_part != data.byteLength) {
                  break;
                }
              }
              buffer.setUint32(nwritten_ptr, nwritten, true);
              return ERRNO_SUCCESS;
            } else {
              return ERRNO_BADF;
            }
          }, fd_read(fd, iovs_ptr, iovs_len, nread_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const iovecs = Iovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
              let nread = 0;
              for (const iovec of iovecs) {
                const { ret, data } = self2.fds[fd].fd_read(iovec.buf_len);
                if (ret != ERRNO_SUCCESS) {
                  buffer.setUint32(nread_ptr, nread, true);
                  return ret;
                }
                buffer8.set(data, iovec.buf);
                nread += data.length;
                if (data.length != iovec.buf_len) {
                  break;
                }
              }
              buffer.setUint32(nread_ptr, nread, true);
              return ERRNO_SUCCESS;
            } else {
              return ERRNO_BADF;
            }
          }, fd_readdir(fd, buf, buf_len, cookie, bufused_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              let bufused = 0;
              while (true) {
                const { ret, dirent } = self2.fds[fd].fd_readdir_single(cookie);
                if (ret != 0) {
                  buffer.setUint32(bufused_ptr, bufused, true);
                  return ret;
                }
                if (dirent == null) {
                  break;
                }
                if (buf_len - bufused < dirent.head_length()) {
                  bufused = buf_len;
                  break;
                }
                const head_bytes = new ArrayBuffer(dirent.head_length());
                dirent.write_head_bytes(new DataView(head_bytes), 0);
                buffer8.set(new Uint8Array(head_bytes).slice(0, Math.min(head_bytes.byteLength, buf_len - bufused)), buf);
                buf += dirent.head_length();
                bufused += dirent.head_length();
                if (buf_len - bufused < dirent.name_length()) {
                  bufused = buf_len;
                  break;
                }
                dirent.write_name_bytes(buffer8, buf, buf_len - bufused);
                buf += dirent.name_length();
                bufused += dirent.name_length();
                cookie = dirent.d_next;
              }
              buffer.setUint32(bufused_ptr, bufused, true);
              return 0;
            } else {
              return ERRNO_BADF;
            }
          }, fd_renumber(fd, to) {
            if (self2.fds[fd] != void 0 && self2.fds[to] != void 0) {
              const ret = self2.fds[to].fd_close();
              if (ret != 0) {
                return ret;
              }
              self2.fds[to] = self2.fds[fd];
              self2.fds[fd] = void 0;
              return 0;
            } else {
              return ERRNO_BADF;
            }
          }, fd_seek(fd, offset, whence, offset_out_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const { ret, offset: offset_out } = self2.fds[fd].fd_seek(offset, whence);
              buffer.setBigInt64(offset_out_ptr, offset_out, true);
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, fd_sync(fd) {
            if (self2.fds[fd] != void 0) {
              return self2.fds[fd].fd_sync();
            } else {
              return ERRNO_BADF;
            }
          }, fd_tell(fd, offset_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const { ret, offset } = self2.fds[fd].fd_tell();
              buffer.setBigUint64(offset_ptr, offset, true);
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const iovecs = Ciovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
              let nwritten = 0;
              for (const iovec of iovecs) {
                const data = buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len);
                const { ret, nwritten: nwritten_part } = self2.fds[fd].fd_write(data);
                if (ret != ERRNO_SUCCESS) {
                  buffer.setUint32(nwritten_ptr, nwritten, true);
                  return ret;
                }
                nwritten += nwritten_part;
                if (nwritten_part != data.byteLength) {
                  break;
                }
              }
              buffer.setUint32(nwritten_ptr, nwritten, true);
              return ERRNO_SUCCESS;
            } else {
              return ERRNO_BADF;
            }
          }, path_create_directory(fd, path_ptr, path_len) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
              return self2.fds[fd].path_create_directory(path);
            } else {
              return ERRNO_BADF;
            }
          }, path_filestat_get(fd, flags, path_ptr, path_len, filestat_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
              const { ret, filestat } = self2.fds[fd].path_filestat_get(flags, path);
              if (filestat != null) {
                filestat.write_bytes(buffer, filestat_ptr);
              }
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, path_filestat_set_times(fd, flags, path_ptr, path_len, atim, mtim, fst_flags) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
              return self2.fds[fd].path_filestat_set_times(flags, path, atim, mtim, fst_flags);
            } else {
              return ERRNO_BADF;
            }
          }, path_link(old_fd, old_flags, old_path_ptr, old_path_len, new_fd, new_path_ptr, new_path_len) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[old_fd] != void 0 && self2.fds[new_fd] != void 0) {
              const old_path = new TextDecoder("utf-8").decode(buffer8.slice(old_path_ptr, old_path_ptr + old_path_len));
              const new_path = new TextDecoder("utf-8").decode(buffer8.slice(new_path_ptr, new_path_ptr + new_path_len));
              const { ret, inode_obj } = self2.fds[old_fd].path_lookup(old_path, old_flags);
              if (inode_obj == null) {
                return ret;
              }
              return self2.fds[new_fd].path_link(new_path, inode_obj, false);
            } else {
              return ERRNO_BADF;
            }
          }, path_open(fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fd_flags, opened_fd_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
              debug.log(path);
              const { ret, fd_obj } = self2.fds[fd].path_open(dirflags, path, oflags, fs_rights_base, fs_rights_inheriting, fd_flags);
              if (ret != 0) {
                return ret;
              }
              self2.fds.push(fd_obj);
              const opened_fd = self2.fds.length - 1;
              buffer.setUint32(opened_fd_ptr, opened_fd, true);
              return 0;
            } else {
              return ERRNO_BADF;
            }
          }, path_readlink(fd, path_ptr, path_len, buf_ptr, buf_len, nread_ptr) {
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
              debug.log(path);
              const { ret, data } = self2.fds[fd].path_readlink(path);
              if (data != null) {
                const data_buf = new TextEncoder().encode(data);
                if (data_buf.length > buf_len) {
                  buffer.setUint32(nread_ptr, 0, true);
                  return ERRNO_BADF;
                }
                buffer8.set(data_buf, buf_ptr);
                buffer.setUint32(nread_ptr, data_buf.length, true);
              }
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, path_remove_directory(fd, path_ptr, path_len) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
              return self2.fds[fd].path_remove_directory(path);
            } else {
              return ERRNO_BADF;
            }
          }, path_rename(fd, old_path_ptr, old_path_len, new_fd, new_path_ptr, new_path_len) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0 && self2.fds[new_fd] != void 0) {
              const old_path = new TextDecoder("utf-8").decode(buffer8.slice(old_path_ptr, old_path_ptr + old_path_len));
              const new_path = new TextDecoder("utf-8").decode(buffer8.slice(new_path_ptr, new_path_ptr + new_path_len));
              let { ret, inode_obj } = self2.fds[fd].path_unlink(old_path);
              if (inode_obj == null) {
                return ret;
              }
              ret = self2.fds[new_fd].path_link(new_path, inode_obj, true);
              if (ret != ERRNO_SUCCESS) {
                if (self2.fds[fd].path_link(old_path, inode_obj, true) != ERRNO_SUCCESS) {
                  throw "path_link should always return success when relinking an inode back to the original place";
                }
              }
              return ret;
            } else {
              return ERRNO_BADF;
            }
          }, path_symlink(old_path_ptr, old_path_len, fd, new_path_ptr, new_path_len) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const old_path = new TextDecoder("utf-8").decode(buffer8.slice(old_path_ptr, old_path_ptr + old_path_len));
              const new_path = new TextDecoder("utf-8").decode(buffer8.slice(new_path_ptr, new_path_ptr + new_path_len));
              return ERRNO_NOTSUP;
            } else {
              return ERRNO_BADF;
            }
          }, path_unlink_file(fd, path_ptr, path_len) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer);
            if (self2.fds[fd] != void 0) {
              const path = new TextDecoder("utf-8").decode(buffer8.slice(path_ptr, path_ptr + path_len));
              return self2.fds[fd].path_unlink_file(path);
            } else {
              return ERRNO_BADF;
            }
          }, poll_oneoff(in_ptr, out_ptr, nsubscriptions) {
            if (nsubscriptions === 0) {
              return ERRNO_INVAL;
            }
            if (nsubscriptions > 1) {
              debug.log("poll_oneoff: only a single subscription is supported");
              return ERRNO_NOTSUP;
            }
            const buffer = new DataView(self2.inst.exports.memory.buffer);
            const s = Subscription.read_bytes(buffer, in_ptr);
            const eventtype = s.eventtype;
            const clockid = s.clockid;
            const timeout = s.timeout;
            if (eventtype !== EVENTTYPE_CLOCK) {
              debug.log("poll_oneoff: only clock subscriptions are supported");
              return ERRNO_NOTSUP;
            }
            let getNow = void 0;
            if (clockid === CLOCKID_MONOTONIC) {
              getNow = () => BigInt(Math.round(performance.now() * 1e6));
            } else if (clockid === CLOCKID_REALTIME) {
              getNow = () => BigInt((/* @__PURE__ */ new Date()).getTime()) * 1000000n;
            } else {
              return ERRNO_INVAL;
            }
            const endTime = (s.flags & SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0 ? timeout : getNow() + timeout;
            while (endTime > getNow()) {
            }
            const event = new Event(s.userdata, ERRNO_SUCCESS, eventtype);
            event.write_bytes(buffer, out_ptr);
            return ERRNO_SUCCESS;
          }, proc_exit(exit_code) {
            throw new WASIProcExit(exit_code);
          }, proc_raise(sig) {
            throw "raised signal " + sig;
          }, sched_yield() {
          }, random_get(buf, buf_len) {
            const buffer8 = new Uint8Array(self2.inst.exports.memory.buffer).subarray(buf, buf + buf_len);
            if ("crypto" in globalThis && (typeof SharedArrayBuffer === "undefined" || !(self2.inst.exports.memory.buffer instanceof SharedArrayBuffer))) {
              for (let i = 0; i < buf_len; i += 65536) {
                crypto.getRandomValues(buffer8.subarray(i, i + 65536));
              }
            } else {
              for (let i = 0; i < buf_len; i++) {
                buffer8[i] = Math.random() * 256 | 0;
              }
            }
          }, sock_recv(fd, ri_data, ri_flags) {
            throw "sockets not supported";
          }, sock_send(fd, si_data, si_flags) {
            throw "sockets not supported";
          }, sock_shutdown(fd, how) {
            throw "sockets not supported";
          }, sock_accept(fd, flags) {
            throw "sockets not supported";
          } };
        }
      };
    }
  });

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/fd.js
  var Fd, Inode;
  var init_fd = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/fd.js"() {
      init_wasi_defs();
      Fd = class {
        fd_allocate(offset, len) {
          return ERRNO_NOTSUP;
        }
        fd_close() {
          return 0;
        }
        fd_fdstat_get() {
          return { ret: ERRNO_NOTSUP, fdstat: null };
        }
        fd_fdstat_set_flags(flags) {
          return ERRNO_NOTSUP;
        }
        fd_fdstat_set_rights(fs_rights_base, fs_rights_inheriting) {
          return ERRNO_NOTSUP;
        }
        fd_filestat_get() {
          return { ret: ERRNO_NOTSUP, filestat: null };
        }
        fd_filestat_set_size(size) {
          return ERRNO_NOTSUP;
        }
        fd_filestat_set_times(atim, mtim, fst_flags) {
          return ERRNO_NOTSUP;
        }
        fd_pread(size, offset) {
          return { ret: ERRNO_NOTSUP, data: new Uint8Array() };
        }
        fd_prestat_get() {
          return { ret: ERRNO_NOTSUP, prestat: null };
        }
        fd_pwrite(data, offset) {
          return { ret: ERRNO_NOTSUP, nwritten: 0 };
        }
        fd_read(size) {
          return { ret: ERRNO_NOTSUP, data: new Uint8Array() };
        }
        fd_readdir_single(cookie) {
          return { ret: ERRNO_NOTSUP, dirent: null };
        }
        fd_seek(offset, whence) {
          return { ret: ERRNO_NOTSUP, offset: 0n };
        }
        fd_sync() {
          return 0;
        }
        fd_tell() {
          return { ret: ERRNO_NOTSUP, offset: 0n };
        }
        fd_write(data) {
          return { ret: ERRNO_NOTSUP, nwritten: 0 };
        }
        path_create_directory(path) {
          return ERRNO_NOTSUP;
        }
        path_filestat_get(flags, path) {
          return { ret: ERRNO_NOTSUP, filestat: null };
        }
        path_filestat_set_times(flags, path, atim, mtim, fst_flags) {
          return ERRNO_NOTSUP;
        }
        path_link(path, inode, allow_dir) {
          return ERRNO_NOTSUP;
        }
        path_unlink(path) {
          return { ret: ERRNO_NOTSUP, inode_obj: null };
        }
        path_lookup(path, dirflags) {
          return { ret: ERRNO_NOTSUP, inode_obj: null };
        }
        path_open(dirflags, path, oflags, fs_rights_base, fs_rights_inheriting, fd_flags) {
          return { ret: ERRNO_NOTDIR, fd_obj: null };
        }
        path_readlink(path) {
          return { ret: ERRNO_NOTSUP, data: null };
        }
        path_remove_directory(path) {
          return ERRNO_NOTSUP;
        }
        path_rename(old_path, new_fd, new_path) {
          return ERRNO_NOTSUP;
        }
        path_unlink_file(path) {
          return ERRNO_NOTSUP;
        }
      };
      Inode = class _Inode {
        static issue_ino() {
          return _Inode.next_ino++;
        }
        static root_ino() {
          return 0n;
        }
        constructor() {
          this.ino = _Inode.issue_ino();
        }
      };
      Inode.next_ino = 1n;
    }
  });

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/fs_mem.js
  var OpenFile, OpenDirectory, PreopenDirectory, File, Path, Directory, ConsoleStdout;
  var init_fs_mem = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/fs_mem.js"() {
      init_debug();
      init_wasi_defs();
      init_fd();
      OpenFile = class extends Fd {
        fd_allocate(offset, len) {
          if (this.file.size > offset + len) {
          } else {
            const new_data = new Uint8Array(Number(offset + len));
            new_data.set(this.file.data, 0);
            this.file.data = new_data;
          }
          return ERRNO_SUCCESS;
        }
        fd_fdstat_get() {
          return { ret: 0, fdstat: new Fdstat(FILETYPE_REGULAR_FILE, 0) };
        }
        fd_filestat_set_size(size) {
          if (this.file.size > size) {
            this.file.data = new Uint8Array(this.file.data.buffer.slice(0, Number(size)));
          } else {
            const new_data = new Uint8Array(Number(size));
            new_data.set(this.file.data, 0);
            this.file.data = new_data;
          }
          return ERRNO_SUCCESS;
        }
        fd_read(size) {
          const slice = this.file.data.slice(Number(this.file_pos), Number(this.file_pos + BigInt(size)));
          this.file_pos += BigInt(slice.length);
          return { ret: 0, data: slice };
        }
        fd_pread(size, offset) {
          const slice = this.file.data.slice(Number(offset), Number(offset + BigInt(size)));
          return { ret: 0, data: slice };
        }
        fd_seek(offset, whence) {
          let calculated_offset;
          switch (whence) {
            case WHENCE_SET:
              calculated_offset = offset;
              break;
            case WHENCE_CUR:
              calculated_offset = this.file_pos + offset;
              break;
            case WHENCE_END:
              calculated_offset = BigInt(this.file.data.byteLength) + offset;
              break;
            default:
              return { ret: ERRNO_INVAL, offset: 0n };
          }
          if (calculated_offset < 0) {
            return { ret: ERRNO_INVAL, offset: 0n };
          }
          this.file_pos = calculated_offset;
          return { ret: 0, offset: this.file_pos };
        }
        fd_tell() {
          return { ret: 0, offset: this.file_pos };
        }
        fd_write(data) {
          if (this.file.readonly) return { ret: ERRNO_BADF, nwritten: 0 };
          if (this.file_pos + BigInt(data.byteLength) > this.file.size) {
            const old = this.file.data;
            this.file.data = new Uint8Array(Number(this.file_pos + BigInt(data.byteLength)));
            this.file.data.set(old);
          }
          this.file.data.set(data, Number(this.file_pos));
          this.file_pos += BigInt(data.byteLength);
          return { ret: 0, nwritten: data.byteLength };
        }
        fd_pwrite(data, offset) {
          if (this.file.readonly) return { ret: ERRNO_BADF, nwritten: 0 };
          if (offset + BigInt(data.byteLength) > this.file.size) {
            const old = this.file.data;
            this.file.data = new Uint8Array(Number(offset + BigInt(data.byteLength)));
            this.file.data.set(old);
          }
          this.file.data.set(data, Number(offset));
          return { ret: 0, nwritten: data.byteLength };
        }
        fd_filestat_get() {
          return { ret: 0, filestat: this.file.stat() };
        }
        constructor(file) {
          super();
          this.file_pos = 0n;
          this.file = file;
        }
      };
      OpenDirectory = class extends Fd {
        fd_seek(offset, whence) {
          return { ret: ERRNO_BADF, offset: 0n };
        }
        fd_tell() {
          return { ret: ERRNO_BADF, offset: 0n };
        }
        fd_allocate(offset, len) {
          return ERRNO_BADF;
        }
        fd_fdstat_get() {
          return { ret: 0, fdstat: new Fdstat(FILETYPE_DIRECTORY, 0) };
        }
        fd_readdir_single(cookie) {
          if (debug.enabled) {
            debug.log("readdir_single", cookie);
            debug.log(cookie, this.dir.contents.keys());
          }
          if (cookie == 0n) {
            return { ret: ERRNO_SUCCESS, dirent: new Dirent(1n, this.dir.ino, ".", FILETYPE_DIRECTORY) };
          } else if (cookie == 1n) {
            return { ret: ERRNO_SUCCESS, dirent: new Dirent(2n, this.dir.parent_ino(), "..", FILETYPE_DIRECTORY) };
          }
          if (cookie >= BigInt(this.dir.contents.size) + 2n) {
            return { ret: 0, dirent: null };
          }
          const [name, entry] = Array.from(this.dir.contents.entries())[Number(cookie - 2n)];
          return { ret: 0, dirent: new Dirent(cookie + 1n, entry.ino, name, entry.stat().filetype) };
        }
        path_filestat_get(flags, path_str) {
          const { ret: path_err, path } = Path.from(path_str);
          if (path == null) {
            return { ret: path_err, filestat: null };
          }
          const { ret, entry } = this.dir.get_entry_for_path(path);
          if (entry == null) {
            return { ret, filestat: null };
          }
          return { ret: 0, filestat: entry.stat() };
        }
        path_lookup(path_str, dirflags) {
          const { ret: path_ret, path } = Path.from(path_str);
          if (path == null) {
            return { ret: path_ret, inode_obj: null };
          }
          const { ret, entry } = this.dir.get_entry_for_path(path);
          if (entry == null) {
            return { ret, inode_obj: null };
          }
          return { ret: ERRNO_SUCCESS, inode_obj: entry };
        }
        path_open(dirflags, path_str, oflags, fs_rights_base, fs_rights_inheriting, fd_flags) {
          const { ret: path_ret, path } = Path.from(path_str);
          if (path == null) {
            return { ret: path_ret, fd_obj: null };
          }
          let { ret, entry } = this.dir.get_entry_for_path(path);
          if (entry == null) {
            if (ret != ERRNO_NOENT) {
              return { ret, fd_obj: null };
            }
            if ((oflags & OFLAGS_CREAT) == OFLAGS_CREAT) {
              const { ret: ret2, entry: new_entry } = this.dir.create_entry_for_path(path_str, (oflags & OFLAGS_DIRECTORY) == OFLAGS_DIRECTORY);
              if (new_entry == null) {
                return { ret: ret2, fd_obj: null };
              }
              entry = new_entry;
            } else {
              return { ret: ERRNO_NOENT, fd_obj: null };
            }
          } else if ((oflags & OFLAGS_EXCL) == OFLAGS_EXCL) {
            return { ret: ERRNO_EXIST, fd_obj: null };
          }
          if ((oflags & OFLAGS_DIRECTORY) == OFLAGS_DIRECTORY && entry.stat().filetype !== FILETYPE_DIRECTORY) {
            return { ret: ERRNO_NOTDIR, fd_obj: null };
          }
          return entry.path_open(oflags, fs_rights_base, fd_flags);
        }
        path_create_directory(path) {
          return this.path_open(0, path, OFLAGS_CREAT | OFLAGS_DIRECTORY, 0n, 0n, 0).ret;
        }
        path_link(path_str, inode, allow_dir) {
          const { ret: path_ret, path } = Path.from(path_str);
          if (path == null) {
            return path_ret;
          }
          if (path.is_dir) {
            return ERRNO_NOENT;
          }
          const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, true);
          if (parent_entry == null || filename == null) {
            return parent_ret;
          }
          if (entry != null) {
            const source_is_dir = inode.stat().filetype == FILETYPE_DIRECTORY;
            const target_is_dir = entry.stat().filetype == FILETYPE_DIRECTORY;
            if (source_is_dir && target_is_dir) {
              if (allow_dir && entry instanceof Directory) {
                if (entry.contents.size == 0) {
                } else {
                  return ERRNO_NOTEMPTY;
                }
              } else {
                return ERRNO_EXIST;
              }
            } else if (source_is_dir && !target_is_dir) {
              return ERRNO_NOTDIR;
            } else if (!source_is_dir && target_is_dir) {
              return ERRNO_ISDIR;
            } else if (inode.stat().filetype == FILETYPE_REGULAR_FILE && entry.stat().filetype == FILETYPE_REGULAR_FILE) {
            } else {
              return ERRNO_EXIST;
            }
          }
          if (!allow_dir && inode.stat().filetype == FILETYPE_DIRECTORY) {
            return ERRNO_PERM;
          }
          parent_entry.contents.set(filename, inode);
          return ERRNO_SUCCESS;
        }
        path_unlink(path_str) {
          const { ret: path_ret, path } = Path.from(path_str);
          if (path == null) {
            return { ret: path_ret, inode_obj: null };
          }
          const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, true);
          if (parent_entry == null || filename == null) {
            return { ret: parent_ret, inode_obj: null };
          }
          if (entry == null) {
            return { ret: ERRNO_NOENT, inode_obj: null };
          }
          parent_entry.contents.delete(filename);
          return { ret: ERRNO_SUCCESS, inode_obj: entry };
        }
        path_unlink_file(path_str) {
          const { ret: path_ret, path } = Path.from(path_str);
          if (path == null) {
            return path_ret;
          }
          const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, false);
          if (parent_entry == null || filename == null || entry == null) {
            return parent_ret;
          }
          if (entry.stat().filetype === FILETYPE_DIRECTORY) {
            return ERRNO_ISDIR;
          }
          parent_entry.contents.delete(filename);
          return ERRNO_SUCCESS;
        }
        path_remove_directory(path_str) {
          const { ret: path_ret, path } = Path.from(path_str);
          if (path == null) {
            return path_ret;
          }
          const { ret: parent_ret, parent_entry, filename, entry } = this.dir.get_parent_dir_and_entry_for_path(path, false);
          if (parent_entry == null || filename == null || entry == null) {
            return parent_ret;
          }
          if (!(entry instanceof Directory) || entry.stat().filetype !== FILETYPE_DIRECTORY) {
            return ERRNO_NOTDIR;
          }
          if (entry.contents.size !== 0) {
            return ERRNO_NOTEMPTY;
          }
          if (!parent_entry.contents.delete(filename)) {
            return ERRNO_NOENT;
          }
          return ERRNO_SUCCESS;
        }
        fd_filestat_get() {
          return { ret: 0, filestat: this.dir.stat() };
        }
        fd_filestat_set_size(size) {
          return ERRNO_BADF;
        }
        fd_read(size) {
          return { ret: ERRNO_BADF, data: new Uint8Array() };
        }
        fd_pread(size, offset) {
          return { ret: ERRNO_BADF, data: new Uint8Array() };
        }
        fd_write(data) {
          return { ret: ERRNO_BADF, nwritten: 0 };
        }
        fd_pwrite(data, offset) {
          return { ret: ERRNO_BADF, nwritten: 0 };
        }
        constructor(dir) {
          super();
          this.dir = dir;
        }
      };
      PreopenDirectory = class extends OpenDirectory {
        fd_prestat_get() {
          return { ret: 0, prestat: Prestat.dir(this.prestat_name) };
        }
        constructor(name, contents) {
          super(new Directory(contents));
          this.prestat_name = name;
        }
      };
      File = class extends Inode {
        path_open(oflags, fs_rights_base, fd_flags) {
          if (this.readonly && (fs_rights_base & BigInt(RIGHTS_FD_WRITE)) == BigInt(RIGHTS_FD_WRITE)) {
            return { ret: ERRNO_PERM, fd_obj: null };
          }
          if ((oflags & OFLAGS_TRUNC) == OFLAGS_TRUNC) {
            if (this.readonly) return { ret: ERRNO_PERM, fd_obj: null };
            this.data = new Uint8Array([]);
          }
          const file = new OpenFile(this);
          if (fd_flags & FDFLAGS_APPEND) file.fd_seek(0n, WHENCE_END);
          return { ret: ERRNO_SUCCESS, fd_obj: file };
        }
        get size() {
          return BigInt(this.data.byteLength);
        }
        stat() {
          return new Filestat(this.ino, FILETYPE_REGULAR_FILE, this.size);
        }
        constructor(data, options) {
          super();
          this.data = new Uint8Array(data);
          this.readonly = !!options?.readonly;
        }
      };
      Path = class Path2 {
        static from(path) {
          const self2 = new Path2();
          self2.is_dir = path.endsWith("/");
          if (path.startsWith("/")) {
            return { ret: ERRNO_NOTCAPABLE, path: null };
          }
          if (path.includes("\0")) {
            return { ret: ERRNO_INVAL, path: null };
          }
          for (const component of path.split("/")) {
            if (component === "" || component === ".") {
              continue;
            }
            if (component === "..") {
              if (self2.parts.pop() == void 0) {
                return { ret: ERRNO_NOTCAPABLE, path: null };
              }
              continue;
            }
            self2.parts.push(component);
          }
          return { ret: ERRNO_SUCCESS, path: self2 };
        }
        to_path_string() {
          let s = this.parts.join("/");
          if (this.is_dir) {
            s += "/";
          }
          return s;
        }
        constructor() {
          this.parts = [];
          this.is_dir = false;
        }
      };
      Directory = class _Directory extends Inode {
        parent_ino() {
          if (this.parent == null) {
            return Inode.root_ino();
          }
          return this.parent.ino;
        }
        path_open(oflags, fs_rights_base, fd_flags) {
          return { ret: ERRNO_SUCCESS, fd_obj: new OpenDirectory(this) };
        }
        stat() {
          return new Filestat(this.ino, FILETYPE_DIRECTORY, 0n);
        }
        get_entry_for_path(path) {
          let entry = this;
          for (const component of path.parts) {
            if (!(entry instanceof _Directory)) {
              return { ret: ERRNO_NOTDIR, entry: null };
            }
            const child = entry.contents.get(component);
            if (child !== void 0) {
              entry = child;
            } else {
              debug.log(component);
              return { ret: ERRNO_NOENT, entry: null };
            }
          }
          if (path.is_dir) {
            if (entry.stat().filetype != FILETYPE_DIRECTORY) {
              return { ret: ERRNO_NOTDIR, entry: null };
            }
          }
          return { ret: ERRNO_SUCCESS, entry };
        }
        get_parent_dir_and_entry_for_path(path, allow_undefined) {
          const filename = path.parts.pop();
          if (filename === void 0) {
            return { ret: ERRNO_INVAL, parent_entry: null, filename: null, entry: null };
          }
          const { ret: entry_ret, entry: parent_entry } = this.get_entry_for_path(path);
          if (parent_entry == null) {
            return { ret: entry_ret, parent_entry: null, filename: null, entry: null };
          }
          if (!(parent_entry instanceof _Directory)) {
            return { ret: ERRNO_NOTDIR, parent_entry: null, filename: null, entry: null };
          }
          const entry = parent_entry.contents.get(filename);
          if (entry === void 0) {
            if (!allow_undefined) {
              return { ret: ERRNO_NOENT, parent_entry: null, filename: null, entry: null };
            } else {
              return { ret: ERRNO_SUCCESS, parent_entry, filename, entry: null };
            }
          }
          if (path.is_dir) {
            if (entry.stat().filetype != FILETYPE_DIRECTORY) {
              return { ret: ERRNO_NOTDIR, parent_entry: null, filename: null, entry: null };
            }
          }
          return { ret: ERRNO_SUCCESS, parent_entry, filename, entry };
        }
        create_entry_for_path(path_str, is_dir) {
          const { ret: path_ret, path } = Path.from(path_str);
          if (path == null) {
            return { ret: path_ret, entry: null };
          }
          let { ret: parent_ret, parent_entry, filename, entry } = this.get_parent_dir_and_entry_for_path(path, true);
          if (parent_entry == null || filename == null) {
            return { ret: parent_ret, entry: null };
          }
          if (entry != null) {
            return { ret: ERRNO_EXIST, entry: null };
          }
          debug.log("create", path);
          let new_child;
          if (!is_dir) {
            new_child = new File(new ArrayBuffer(0));
          } else {
            new_child = new _Directory(/* @__PURE__ */ new Map());
          }
          parent_entry.contents.set(filename, new_child);
          entry = new_child;
          return { ret: ERRNO_SUCCESS, entry };
        }
        constructor(contents) {
          super();
          this.parent = null;
          if (contents instanceof Array) {
            this.contents = new Map(contents);
          } else {
            this.contents = contents;
          }
          for (const entry of this.contents.values()) {
            if (entry instanceof _Directory) {
              entry.parent = this;
            }
          }
        }
      };
      ConsoleStdout = class _ConsoleStdout extends Fd {
        fd_filestat_get() {
          const filestat = new Filestat(this.ino, FILETYPE_CHARACTER_DEVICE, BigInt(0));
          return { ret: 0, filestat };
        }
        fd_fdstat_get() {
          const fdstat = new Fdstat(FILETYPE_CHARACTER_DEVICE, 0);
          fdstat.fs_rights_base = BigInt(RIGHTS_FD_WRITE);
          return { ret: 0, fdstat };
        }
        fd_write(data) {
          this.write(data);
          return { ret: 0, nwritten: data.byteLength };
        }
        static lineBuffered(write) {
          const dec = new TextDecoder("utf-8", { fatal: false });
          let line_buf = "";
          return new _ConsoleStdout((buffer) => {
            line_buf += dec.decode(buffer, { stream: true });
            const lines = line_buf.split("\n");
            for (const [i, line] of lines.entries()) {
              if (i < lines.length - 1) {
                write(line);
              } else {
                line_buf = line;
              }
            }
          });
        }
        constructor(write) {
          super();
          this.ino = Inode.issue_ino();
          this.write = write;
        }
      };
    }
  });

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/fs_opfs.js
  var SyncOPFSFile, OpenSyncOPFSFile;
  var init_fs_opfs = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/fs_opfs.js"() {
      init_wasi_defs();
      init_fd();
      SyncOPFSFile = class extends Inode {
        path_open(oflags, fs_rights_base, fd_flags) {
          if (this.readonly && (fs_rights_base & BigInt(RIGHTS_FD_WRITE)) == BigInt(RIGHTS_FD_WRITE)) {
            return { ret: ERRNO_PERM, fd_obj: null };
          }
          if ((oflags & OFLAGS_TRUNC) == OFLAGS_TRUNC) {
            if (this.readonly) return { ret: ERRNO_PERM, fd_obj: null };
            this.handle.truncate(0);
          }
          const file = new OpenSyncOPFSFile(this);
          if (fd_flags & FDFLAGS_APPEND) file.fd_seek(0n, WHENCE_END);
          return { ret: ERRNO_SUCCESS, fd_obj: file };
        }
        get size() {
          return BigInt(this.handle.getSize());
        }
        stat() {
          return new Filestat(this.ino, FILETYPE_REGULAR_FILE, this.size);
        }
        constructor(handle, options) {
          super();
          this.handle = handle;
          this.readonly = !!options?.readonly;
        }
      };
      OpenSyncOPFSFile = class extends Fd {
        fd_allocate(offset, len) {
          if (BigInt(this.file.handle.getSize()) > offset + len) {
          } else {
            this.file.handle.truncate(Number(offset + len));
          }
          return ERRNO_SUCCESS;
        }
        fd_fdstat_get() {
          return { ret: 0, fdstat: new Fdstat(FILETYPE_REGULAR_FILE, 0) };
        }
        fd_filestat_get() {
          return { ret: 0, filestat: new Filestat(this.ino, FILETYPE_REGULAR_FILE, BigInt(this.file.handle.getSize())) };
        }
        fd_filestat_set_size(size) {
          this.file.handle.truncate(Number(size));
          return ERRNO_SUCCESS;
        }
        fd_read(size) {
          const buf = new Uint8Array(size);
          const n = this.file.handle.read(buf, { at: Number(this.position) });
          this.position += BigInt(n);
          return { ret: 0, data: buf.slice(0, n) };
        }
        fd_seek(offset, whence) {
          let calculated_offset;
          switch (whence) {
            case WHENCE_SET:
              calculated_offset = BigInt(offset);
              break;
            case WHENCE_CUR:
              calculated_offset = this.position + BigInt(offset);
              break;
            case WHENCE_END:
              calculated_offset = BigInt(this.file.handle.getSize()) + BigInt(offset);
              break;
            default:
              return { ret: ERRNO_INVAL, offset: 0n };
          }
          if (calculated_offset < 0) {
            return { ret: ERRNO_INVAL, offset: 0n };
          }
          this.position = calculated_offset;
          return { ret: ERRNO_SUCCESS, offset: this.position };
        }
        fd_write(data) {
          if (this.file.readonly) return { ret: ERRNO_BADF, nwritten: 0 };
          const n = this.file.handle.write(data, { at: Number(this.position) });
          this.position += BigInt(n);
          return { ret: ERRNO_SUCCESS, nwritten: n };
        }
        fd_sync() {
          this.file.handle.flush();
          return ERRNO_SUCCESS;
        }
        constructor(file) {
          super();
          this.position = 0n;
          this.file = file;
          this.ino = Inode.issue_ino();
        }
      };
    }
  });

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/strace.js
  function strace(imports, no_trace) {
    return new Proxy(imports, { get(target, prop, receiver) {
      const f = Reflect.get(target, prop, receiver);
      if (no_trace.includes(prop)) {
        return f;
      }
      return function(...args) {
        const result = Reflect.apply(f, receiver, args);
        return result;
      };
    } });
  }
  var init_strace = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/strace.js"() {
    }
  });

  // ../node_modules/@bjorn3/browser_wasi_shim/dist/index.js
  var dist_exports = {};
  __export(dist_exports, {
    ConsoleStdout: () => ConsoleStdout,
    Directory: () => Directory,
    Fd: () => Fd,
    File: () => File,
    Inode: () => Inode,
    OpenDirectory: () => OpenDirectory,
    OpenFile: () => OpenFile,
    OpenSyncOPFSFile: () => OpenSyncOPFSFile,
    PreopenDirectory: () => PreopenDirectory,
    SyncOPFSFile: () => SyncOPFSFile,
    WASI: () => WASI,
    WASIProcExit: () => WASIProcExit,
    strace: () => strace,
    wasi: () => wasi_defs_exports
  });
  var init_dist = __esm({
    "../node_modules/@bjorn3/browser_wasi_shim/dist/index.js"() {
      init_wasi();
      init_fd();
      init_fs_mem();
      init_fs_opfs();
      init_strace();
      init_wasi_defs();
    }
  });

  // src/web/runWorker.js
  init_dist();
  var post = (m, transfer) => self.postMessage(m, transfer || []);
  var TermStdin = class extends Fd {
    constructor(sab) {
      super();
      this.ctrl = new Int32Array(sab, 0, 2);
      this.buf = new Uint8Array(sab, 8);
      this._justServed = false;
    }
    fd_fdstat_get() {
      return { ret: 0, fdstat: { fs_filetype: 2, fs_flags: 0, fs_rights_base: 0xffffffffn, fs_rights_inheriting: 0xffffffffn } };
    }
    /** 由 runWasi 在【每个 wasi fd_read syscall 结束时】调用：
     *  Fd.fd_read 是逐 iovec 调的，_justServed 必须限制在"同一次 syscall 内"，
     *  否则短读之后的下一次 syscall 会看到残留标记 → 立刻返回空 → 假 EOF（cin 只读到第一行）。 */
    resetJustServed() {
      this._justServed = false;
    }
    fd_read(size) {
      const t0 = Date.now();
      for (; ; ) {
        const st = Atomics.load(this.ctrl, 0);
        if (st === 3) {
          this._justServed = false;
          return { ret: 0, data: new Uint8Array(0) };
        }
        if (st === 1) {
          const len = Atomics.load(this.ctrl, 1);
          const n = Math.min(size, len);
          const data = this.buf.slice(0, n);
          const rest = len - n;
          if (rest > 0) this.buf.copyWithin(0, n, len);
          Atomics.store(this.ctrl, 1, rest);
          Atomics.store(this.ctrl, 0, rest > 0 ? 1 : 0);
          Atomics.notify(this.ctrl, 0);
          post({ type: "consumed" });
          this._justServed = true;
          return { ret: 0, data };
        }
        if (this._justServed) {
          this._justServed = false;
          return { ret: 0, data: new Uint8Array(0) };
        }
        const waited = Date.now() - t0;
        if (waited > 18e5 && !this._warnedIdle) {
          this._warnedIdle = true;
          post({ type: "out", stream: "stderr", bytes: new TextEncoder().encode("\n[oi] \u5DF2\u7B49\u5F85 stdin 30 \u5206\u949F\u2026\n").buffer });
        }
        Atomics.wait(this.ctrl, 0, 0, 3e4);
      }
    }
  };
  var running = false;
  self.onmessage = async (ev) => {
    const m = ev.data || {};
    try {
      if (m.type === "run") {
        if (running) throw new Error("already running");
        running = true;
        const { bytes, stdinSAB } = m;
        const stdin = stdinSAB ? new TermStdin(stdinSAB) : void 0;
        const onOut = (b) => {
          const c = b.slice();
          post({ type: "out", stream: "stdout", bytes: c.buffer }, [c.buffer]);
        };
        const onErr = (b) => {
          const c = b.slice();
          post({ type: "out", stream: "stderr", bytes: c.buffer }, [c.buffer]);
        };
        const code = await runWasi(bytes, { stdin, onOut, onErr });
        post({ type: "exited", code });
        running = false;
        return;
      }
      if (m.type === "ping") {
        post({ type: "pong" });
        return;
      }
      throw new Error("\u672A\u77E5\u6D88\u606F " + m.type);
    } catch (e) {
      running = false;
      post({ type: "error", message: e && (e.stack || e.message) || String(e) });
    }
  };
  async function runWasi(bytes, { stdin, onOut, onErr }) {
    const { WASI: WASI3, WASIProcExit: WASIProcExit2, ConsoleStdout: ConsoleStdout2, PreopenDirectory: PreopenDirectory2, File: File2, Directory: Directory2, OpenFile: OpenFile2 } = await Promise.resolve().then(() => (init_dist(), dist_exports));
    const root = new Directory2(/* @__PURE__ */ new Map());
    const fd0 = stdin ?? new OpenFile2(new File2(new Uint8Array(0)));
    const fds = [fd0, new ConsoleStdout2(onOut), new ConsoleStdout2(onErr), new PreopenDirectory2("/", root.contents)];
    const wasi = new WASI3(["program"], [], fds);
    const origFdRead = wasi.wasiImport.fd_read;
    wasi.wasiImport.fd_read = (...args) => {
      try {
        return origFdRead(...args);
      } finally {
        try {
          stdin?.resetJustServed?.();
        } catch {
        }
      }
    };
    const mod = await WebAssembly.compile(bytes);
    const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
    try {
      return wasi.start(inst) ?? 0;
    } catch (e) {
      if (e instanceof WASIProcExit2) return e.code;
      throw e;
    }
  }
})();
