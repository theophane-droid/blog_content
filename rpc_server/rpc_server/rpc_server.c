#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "Interface_h.h"

void __RPC_FAR* __RPC_USER midl_user_allocate(size_t len) {
    return malloc(len);
}

void __RPC_USER midl_user_free(void __RPC_FAR* ptr) {
    free(ptr);
}

void print_usage(const char* program_name) {
    printf("Usage: %s [-e] <port>\n", program_name);
    printf("\nOptions:\n");
    printf("  -e           Use endpoint mapper (dynamic port allocation)\n");
    printf("  <port>       Specific port to bind (without -e)\n");
    printf("\nExamples:\n");
    printf("  %s 50001           - Bind to specific port 50001\n", program_name);
    printf("  %s -e              - Use endpoint mapper (dynamic port)\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status;
    BOOL use_endpoint_mapper = FALSE;
    wchar_t port[16] = {0};
    char* port_arg = NULL;
    
    // Parse command line arguments
    if (argc < 2 || argc > 3) {
        print_usage(argv[0]);
        return 1;
    }
    
    // Check for -e flag
    int arg_idx = 1;
    if (strcmp(argv[1], "-e") == 0) {
        use_endpoint_mapper = TRUE;
        arg_idx = 2;
        
        // With -e, port is optional (will use dynamic)
        if (argc > 2) {
            port_arg = argv[2];
        }
    } else {
        // No -e flag, port is required
        if (argc != 2) {
            print_usage(argv[0]);
            return 1;
        }
        port_arg = argv[1];
    }
    
    // Convert port to wchar_t if provided
    if (port_arg) {
        MultiByteToWideChar(CP_ACP, 0, port_arg, -1, port, 16);
    }
    
    // Create security descriptor
    SECURITY_DESCRIPTOR sd;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE);
    
    if (use_endpoint_mapper) {
        printf("Starting RPC server with endpoint mapper...\n");
        
        // Use protocol sequence without specific endpoint
        // This allows the RPC runtime to assign a dynamic port
        status = RpcServerUseProtseq(
            (RPC_WSTR)L"ncacn_ip_tcp",
            RPC_C_PROTSEQ_MAX_REQS_DEFAULT,
            &sd
        );
        
        if (status != RPC_S_OK) {
            printf("Error RpcServerUseProtseq: 0x%x\n", status);
            return 1;
        }
        
        printf("Protocol sequence registered (dynamic port)\n");
        
    } else {
        printf("Starting RPC server on port %s...\n", port_arg);
        
        // Use specific endpoint (port)
        status = RpcServerUseProtseqEp(
            (RPC_WSTR)L"ncacn_ip_tcp",
            RPC_C_PROTSEQ_MAX_REQS_DEFAULT,
            port,
            &sd
        );
        
        if (status != RPC_S_OK) {
            printf("Error RpcServerUseProtseqEp: 0x%x\n", status);
            return 1;
        }
        
        printf("Protocol sequence registered on port %s\n", port_arg);
    }
    
    // Register interface
    status = RpcServerRegisterIf2(
        MyInterface_v1_0_s_ifspec,
        NULL,
        NULL,
        RPC_IF_ALLOW_CALLBACKS_WITH_NO_AUTH,
        RPC_C_LISTEN_MAX_CALLS_DEFAULT,
        (unsigned int)-1,
        NULL
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerRegisterIf2: 0x%x\n", status);
        return 1;
    }
    
    printf("Interface registered successfully!\n");
    
    // Register endpoints with endpoint mapper if using dynamic ports
    if (use_endpoint_mapper) {
        status = RpcEpRegister(
            MyInterface_v1_0_s_ifspec,
            NULL,  // Binding vector (NULL = use all)
            NULL,  // UUID vector
            (RPC_WSTR)L"RPC Command Executor Service"  // Annotation
        );
        
        if (status != RPC_S_OK) {
            printf("Warning: RpcEpRegister failed: 0x%x (continuing anyway)\n", status);
        } else {
            printf("Endpoints registered with endpoint mapper\n");
            printf("Clients can discover this service via endpoint mapper on port 135\n");
        }
    }
    
    printf("Server ready. Press Ctrl+C to stop.\n");
    
    // Start listening
    status = RpcServerListen(1, RPC_C_LISTEN_MAX_CALLS_DEFAULT, FALSE);
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerListen: 0x%x\n", status);
        
        // Cleanup endpoint mapper registration
        if (use_endpoint_mapper) {
            RpcEpUnregister(MyInterface_v1_0_s_ifspec, NULL, NULL);
        }
        
        return 1;
    }
    
    // Cleanup (this code is reached after Ctrl+C or stop signal)
    if (use_endpoint_mapper) {
        printf("Unregistering from endpoint mapper...\n");
        RpcEpUnregister(MyInterface_v1_0_s_ifspec, NULL, NULL);
    }
    
    return 0;
}
