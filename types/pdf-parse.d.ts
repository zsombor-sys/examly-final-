declare module 'pdf-parse' {
  export interface PdfParseResult {
    text: string
    numpages?: number
    numrender?: number
    info?: any
    metadata?: any
    version?: string
  }

  type PdfParse = (data: any, options?: any) => Promise<PdfParseResult>

  const pdfParse: PdfParse
  export default pdfParse
}
