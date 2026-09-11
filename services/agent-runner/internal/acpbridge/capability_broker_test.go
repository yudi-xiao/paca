package acpbridge

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutesMountCapabilityBrokerOnlyAtPrivateProtocolPath(t *testing.T) {
	calls := 0
	server := &Server{CapabilityBroker: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		response.WriteHeader(http.StatusNoContent)
	})}

	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/agent-capabilities", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || calls != 1 {
		t.Fatalf("broker response = %d, calls = %d", response.Code, calls)
	}

	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/agent-capabilities", nil)
	response = httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed || calls != 1 {
		t.Fatalf("wrong-method response = %d, calls = %d", response.Code, calls)
	}
}
