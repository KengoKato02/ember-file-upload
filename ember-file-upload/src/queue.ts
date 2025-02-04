import { action } from '@ember/object';
import { modifier } from 'ember-modifier';
import { TrackedSet } from 'tracked-built-ins';
import { UploadFile } from './upload-file.ts';
import type FileQueueService from './services/file-queue.ts';
import {
  FileSource,
  FileState,
  type QueueListener,
  type QueueName,
  type SelectFileSignature,
} from './interfaces.ts';

/**
 * The Queue is a collection of files that
 * are being manipulated by the user.
 *
 * Queues are designed to persist the state
 * of uploads when a user navigates around your
 * application.
 */
export class Queue {
  #listeners: Set<QueueListener> = new Set();

  #name: QueueName;

  /**
   * The unique identifier of the queue.
   *
   * @remarks
   * Queue names should be deterministic so they
   * can be retrieved. It's recommended to provide
   * a helpful name.
   *
   * If the queue belongs to a top level collection,
   * photos, the good name for this queue may be `"photos"`.
   *
   * If you're uploading images to an artwork, the
   * best name would incoporate both `"artworks"` and
   * the identifier of the artwork. A good name for this
   * queue may be `"artworks/{{id}}/photos"`, where `{{id}}`
   * is a dynamic segment that is generated from the artwork id.
   */
  get name(): QueueName {
    return this.#name;
  }

  /** The FileQueue service. */
  fileQueue: FileQueueService;

  #distinctFiles: Set<UploadFile> = new TrackedSet();

  /**
   * The list of files in the queue. This automatically gets
   * flushed when all the files in the queue have settled.
   *
   * @remarks
   * Note that files that have failed need to be manually
   * removed from the queue. This is so they can be retried
   * without resetting the state of the queue, orphaning the
   * file from its queue. Upload failures can happen due to a
   * timeout or a server response. If you choose to use the
   * `abort` method, the file will fail to upload, but will
   * be removed from the requeuing proccess, and will be
   * considered to be in a settled state.
   *
   * @defaultValue []
   */
  get files(): UploadFile[] {
    return [...this.#distinctFiles.values()];
  }

  /**
   * The current time in ms it is taking to upload 1 byte.
   *
   * @defaultValue 0
   */
  get rate(): number {
    return this.files
      .filter((file) => file.state === FileState.Uploading)
      .reduce((acc, { rate }) => {
        return acc + rate;
      }, 0);
  }

  /**
   * The total size of all files currently being uploaded in bytes.
   *
   * @defaultValue 0
   */
  get size(): number {
    return this.files.reduce((acc, { size }) => {
      return acc + size;
    }, 0);
  }

  /**
   * The number of bytes that have been uploaded to the server.
   *
   * @defaultValue 0
   */
  get loaded(): number {
    return this.files.reduce((acc, { loaded }) => {
      return acc + loaded;
    }, 0);
  }

  /**
   * The current progress of all uploads, as a percentage in the
   * range of 0 to 100.
   *
   * @defaultValue 0
   */
  get progress() {
    const percent = this.loaded / this.size || 0;
    return Math.floor(percent * 100);
  }

  constructor({
    name,
    fileQueue,
  }: {
    name: QueueName;
    fileQueue: FileQueueService;
  }) {
    this.#name = name;
    this.fileQueue = fileQueue;
  }

  addListener(listener: QueueListener) {
    this.#listeners.add(listener);
  }

  removeListener(listener: QueueListener) {
    this.#listeners.delete(listener);
  }

  /**
   * Add a file to the queue
   * @param file the file to be added
   */
  @action
  add(file: UploadFile) {
    if (this.#distinctFiles.has(file)) {
      return;
    }

    file.queue = this;
    this.#distinctFiles.add(file);

    for (const listener of this.#listeners) {
      listener.onFileAdded?.(file);
    }
  }

  /**
   * Remove a file from the queue
   * @param file the file to be removed
   */
  @action
  remove(file: UploadFile) {
    if (!this.#distinctFiles.has(file)) {
      return;
    }

    file.queue = undefined;
    this.#distinctFiles.delete(file);

    for (const listener of this.#listeners) {
      listener.onFileRemoved?.(file);
    }
  }

  uploadStarted(file: UploadFile) {
    for (const listener of this.#listeners) {
      listener.onUploadStarted?.(file);
    }
  }

  uploadSucceeded(file: UploadFile, response: Response) {
    for (const listener of this.#listeners) {
      listener.onUploadSucceeded?.(file, response);
    }
  }

  uploadFailed(file: UploadFile, response: Response) {
    for (const listener of this.#listeners) {
      listener.onUploadFailed?.(file, response);
    }
  }

  /**
   * Get the URL of a fille from the queue
   * @param file the file to retrieve the url from
   */
  @action
  getUrl(file: UploadFile) {
    // write function with the file reader api to get the url of the file
    if(!file) {
      return;
    }
  
    return new Promise((resolve, reject) => {
      let reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Flushes the `files` property if they have settled. This
   * will only flush files when all files have arrived at a terminus
   * of their state chart (`uploaded` and `aborted`).
   *
   * Files *may* be requeued by the user in the `failed` or `timed_out`
   * states.
   */
  flush() {
    if (this.files.length === 0) {
      return;
    }

    const allFilesHaveSettled = this.files.every((file) => {
      return [FileState.Uploaded, FileState.Aborted].includes(file.state);
    });

    if (allFilesHaveSettled) {
      this.files.forEach((file) => (file.queue = undefined));
      this.#distinctFiles.clear();
    }
  }

  selectFile = modifier<SelectFileSignature>(
    (element, _positional, { filter, onFilesSelected }) => {
      const changeHandler = (event: Event) => {
        const { files: fileList } = event.target as HTMLInputElement;
        if (!fileList) {
          return;
        }

        const files = Array.from(fileList);
        const selectedFiles: UploadFile[] = [];

        for (const file of files) {
          if (filter && !filter?.(file, files, files.indexOf(file))) {
            continue;
          }

          let uploadFile;
          if (file instanceof File) {
            uploadFile = new UploadFile(file, FileSource.Browse);
          }
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          else if (file instanceof Blob) {
            uploadFile = UploadFile.fromBlob(file, FileSource.Browse);
          }

          if (uploadFile) {
            selectedFiles.push(uploadFile);
            this.add(uploadFile);
          }
        }

        onFilesSelected?.(selectedFiles);

        // this will reset the input, so the _same_ file can be picked again
        // Without, the `change` event wouldn't be fired, as it is still the same
        // value
        element.value = '';
      };
      element.addEventListener('change', changeHandler);

      return () => {
        element.removeEventListener('change', changeHandler);
      };
    },
    // used to opt-in to lazy argument handling, which is the default for ember-modifier@^4
    { eager: false },
  );
}
