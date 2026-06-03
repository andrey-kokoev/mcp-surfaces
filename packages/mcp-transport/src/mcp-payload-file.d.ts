export declare const DEFAULT_INLINE_PAYLOAD_CHAR_LIMIT = 200;
export declare const DEFAULT_INLINE_OUTPUT_CHAR_LIMIT = 200;
export declare const DEFAULT_OUTPUT_SHOW_CHAR_LIMIT = 10000;
export declare function resolveToolPayloadArgs({ siteRoot, toolName, args, allowedTools, maxBytes, payloadDir, payloadRefMode, }: {
    siteRoot: any;
    toolName: any;
    args: any;
    allowedTools: any;
    maxBytes?: number;
    payloadDir?: string;
    payloadRefMode?: string;
}): {
    args: any;
    payloadSource: {
        kind: string;
        ref: any;
        payload_id: string;
        revision: number;
        byte_size: any;
        sha256: any;
        max_bytes: number;
        transient_not_authority: boolean;
        path?: undefined;
    };
} | {
    args: any;
    payloadSource: {
        kind: string;
        path: any;
        byte_size: any;
        max_bytes: number;
        transient_not_authority: boolean;
        ref?: undefined;
        payload_id?: undefined;
        revision?: undefined;
        sha256?: undefined;
    };
};
export declare function attachPayloadSource(result: any, payloadSource: any): any;
export declare function enforceInlinePayloadLimit({ toolName, args, limit, exemptFields, objectPayloadFields, allowPayloadCreation, }?: any): void;
export declare function payloadCreate({ siteRoot, args, maxBytes, payloadDir }: {
    siteRoot: any;
    args: any;
    maxBytes?: number;
    payloadDir?: string;
}): {
    status: any;
    ref: any;
    payload_id: any;
    revision: any;
    source_ref: any;
    byte_size: any;
    sha256: any;
    created_at: any;
    created_by: any;
    transient_not_authority: boolean;
    immutable_revision: boolean;
    payload: any;
};
export declare function payloadShow({ siteRoot, args, maxBytes, payloadDir }: {
    siteRoot: any;
    args: any;
    maxBytes?: number;
    payloadDir?: string;
}): {
    status: any;
    ref: any;
    payload_id: any;
    revision: any;
    source_ref: any;
    byte_size: any;
    sha256: any;
    created_at: any;
    created_by: any;
    transient_not_authority: boolean;
    immutable_revision: boolean;
    payload: any;
};
export declare function payloadValidate({ siteRoot, args, maxBytes, payloadDir }: {
    siteRoot: any;
    args: any;
    maxBytes?: number;
    payloadDir?: string;
}): {
    status: any;
    ref: any;
    payload_id: any;
    revision: any;
    source_ref: any;
    byte_size: any;
    sha256: any;
    created_at: any;
    created_by: any;
    transient_not_authority: boolean;
    immutable_revision: boolean;
    payload: any;
};
export declare function payloadDerive({ siteRoot, args, maxBytes, payloadDir }: {
    siteRoot: any;
    args: any;
    maxBytes?: number;
    payloadDir?: string;
}): {
    status: any;
    ref: any;
    payload_id: any;
    revision: any;
    source_ref: any;
    byte_size: any;
    sha256: any;
    created_at: any;
    created_by: any;
    transient_not_authority: boolean;
    immutable_revision: boolean;
    payload: any;
};
export declare function buildOutputRefToolContent({ siteRoot, toolName, value, isError, limit, createdBy, }?: any): {
    isError?: boolean;
    content: {
        type: string;
        text: string;
    }[];
};
export declare function outputShow({ siteRoot, args, maxBytes, outputDir }: {
    siteRoot: any;
    args: any;
    maxBytes?: number;
    outputDir?: string;
}): {
    schema: string;
    status: string;
    ref: any;
    tool_name: any;
    full_output_char_length: any;
    byte_size: any;
    original_truncated: boolean;
    path: any;
    output_limit: number;
    output_truncated: boolean;
    output_text: string;
};
export declare function listOutputTools(): {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            ref: {
                type: string;
                description: string;
            };
            output_ref: {
                type: string;
                description: string;
            };
            output_limit: {
                type: string;
                description: string;
            };
        };
    };
}[];
export declare function listPayloadTools(): ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        additionalProperties: boolean;
        properties: {
            payload_id: {
                type: string;
                description: string;
            };
            payload: {
                type: string;
                description: string;
            };
            created_by: {
                type: string;
                description: string;
            };
            ref?: undefined;
            source_ref?: undefined;
            overlay?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        additionalProperties: boolean;
        properties: {
            ref: {
                type: string;
                description: string;
            };
            payload_id?: undefined;
            payload?: undefined;
            created_by?: undefined;
            source_ref?: undefined;
            overlay?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        additionalProperties: boolean;
        properties: {
            source_ref: {
                type: string;
                description: string;
            };
            overlay: {
                type: string;
                description: string;
            };
            created_by: {
                type: string;
                description: string;
            };
            payload_id?: undefined;
            payload?: undefined;
            ref?: undefined;
        };
        required: string[];
    };
})[];
